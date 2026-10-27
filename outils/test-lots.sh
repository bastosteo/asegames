#!/usr/bin/env bash
# SITE DE TEST : nouvelle Raffle et nouvel Airdrop de test avec les lots « pleins puis le reste »
# (ex. 450 ASE pour des lots de 100 : 100, 100, 100, 100 puis 50 ; un lot ne dépasse jamais le 3e prix).
# Le Loto et le Treasure de test envoient ensuite leurs 6 % au nouvel Airdrop de test.
# Lancé par "Nouveaux-lots-test.bat". Ne touche pas aux vrais jeux.
# ⚠️ Chaque transaction depuis "main" est demandée (o/n) avant. Relançable sans risque.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
get() { node -e "const v=JSON.parse(process.argv[1]);console.log(v==null||v['$2']==null?'':v['$2'])" "$1"; }
attendre_cfg() { for i in $(seq 1 36); do sleep 5; [ "$(get "$($AIDE cfg "$1")" "$2")" = "$3" ] && { echo " ok"; return; }; echo -n "."; done; echo " (pas encore confirmé)"; }

npm install --prefix croupier --no-audit --no-fund --silent
for n in tombola airdrop; do grep -q '\*6n' contrat/$n.deploy.js || { echo "ERREUR : contrat/$n.deploy.js n'est pas la nouvelle version (ancien zip ?)."; exit 1; }; done
for n in loto raffle tresor airdrop; do [ -f ".test-$n" ] || { echo "ERREUR : .test-$n introuvable (lance Installer-site-test.bat)."; exit 1; }; done
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || { echo "ERREUR : GitHub non connecté."; exit 1; }
R="$(gh api user --jq .login)/asegames"
setvar() { gh api -X PATCH "repos/$R/actions/variables/$1" -f name="$1" -f value="$2" >/dev/null 2>&1 || gh api -X POST "repos/$R/actions/variables" -f name="$1" -f value="$2" >/dev/null; }

# déploie + init (idempotent) ; $1 = nom du marqueur, $2 = fichier, $3 = args init (JSON)
deployer() {
  local M=".test-lots-$1" N=""
  [ -s "$M" ] && [ -n "$(get "$($AIDE cfg "$(cat "$M")")" admin)" ] && { cat "$M"; return; }
  rm -f "$M"
  [ -f "$M-contrat" ] && N=$(cat "$M-contrat")
  if [ -z "$N" ]; then
    oui "      ⚠️  Déployer $2 ($(wc -c < "$2") octets) depuis main ?" >&2 || exit 1
    local OUT; OUT=$(asentum deploy "$2" --from main 2>&1) || true; echo "$OUT" >&2
    N=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
    [ -n "$N" ] || { echo "ERREUR : adresse du contrat introuvable." >&2; exit 1; }
    echo "$N" > "$M-contrat"
    echo -n "      Attente de l'inclusion… " >&2; $AIDE attendre "$N" deploye >&2
  fi
  if [ -z "$(get "$($AIDE cfg "$N")" admin)" ]; then
    echo "      init $3" >&2
    oui "      ⚠️  Envoyer init depuis main ?" >&2 || exit 1
    asentum call "$N" init --from main --args "$3" >&2
    echo -n "      Attente de la confirmation… " >&2; $AIDE attendre "$N" initialise >&2
  fi
  echo "$N" > "$M"; rm -f "$M-contrat"; echo "$N"
}

OA=$(cat .test-airdrop); OR=$(cat .test-raffle); L=$(cat .test-loto); G=$(cat .test-tresor)
# Marqueurs périmés (adresse égale à la Raffle / l'Airdrop de test actuels, ou ancienne version) : on repart de zéro
if [ ! -f .test-lots-v2 ]; then rm -f .test-lots-fini .test-lots-raffle .test-lots-airdrop .test-lots-raffle-contrat .test-lots-airdrop-contrat; touch .test-lots-v2; fi
for m in .test-lots-raffle .test-lots-airdrop; do [ -f "$m" ] && { [ "$(cat "$m")" = "$OR" ] || [ "$(cat "$m")" = "$OA" ]; } && rm -f "$m" .test-lots-fini; done
# Déjà fait seulement si le marqueur contient l'adresse de la Raffle de test actuelle (sinon : marqueur périmé, on l'ignore)
if [ -s .test-lots-fini ] && [ "$(cat .test-lots-fini)" = "$OR" ]; then echo "Déjà fait : Raffle de test $OR, Airdrop de test $OA."; echo "Site de test : https://asevegas-test.pages.dev"; exit 0; fi
rm -f .test-lots-fini
echo "Raffle de test actuelle (ancienne version) : $OR"
echo "Airdrop de test actuel (ancienne version) : $OA"

echo "[1/4] Nouvel Airdrop de test…"
AC=$($AIDE cfg "$OA"); AS=$($AIDE etat "$OA")
A=$(deployer airdrop contrat/airdrop.deploy.js "[\"$(get "$AC" operator)\",\"$(get "$AC" collabAdmin)\",\"$(get "$AS" tipO)\",\"$(get "$AS" tipC)\"]")
AH=$($AIDE hex "$A"); echo "      Airdrop de test : $A"

echo "[2/4] Nouvelle Raffle de test…"
RC=$($AIDE cfg "$OR"); RS=$($AIDE etat "$OR")
F=$(deployer raffle contrat/tombola.deploy.js "[\"$(get "$RC" payOwner)\",\"$(get "$RC" payCollab)\",\"$(get "$RC" collabAdmin)\",\"$(get "$RS" tipO)\",\"$(get "$RS" tipC)\",\"$AH\"]")
echo "      Raffle de test : $F"
if [ "$(get "$($AIDE cfg "$F")" closeMin)" != "$(get "$RC" closeMin)" ] || [ "$(get "$($AIDE cfg "$F")" price)" != "$(get "$RC" price)" ]; then
  A2="[\"$(get "$RC" price)\",$(get "$RC" drawDays),$(get "$RC" drawH),$(get "$RC" drawM),$(get "$RC" maxPerWallet),$(get "$RC" closeMin),$(get "$RC" revealMin),$(get "$RC" maxRound)]"
  echo "      setConfig $A2   (mêmes réglages que l'ancienne Raffle de test)"
  if oui "      ⚠️  Envoyer setConfig sur la nouvelle Raffle de test depuis main ?"; then
    asentum call "$F" setConfig --from main --args "$A2"; echo -n "      Attente…"; attendre_cfg "$F" closeMin "$(get "$RC" closeMin)"
  fi
fi
if [ "$(get "$RC" paused)" != "true" ] && oui "      ⚠️  Mettre l'ancienne Raffle de test en pause (setPaused [true]) depuis main ?"; then asentum call "$OR" setPaused --from main --args '[true]' || true; sleep 8; fi

echo "[3/4] Le Loto et le Treasure de test envoient leurs 6 % au nouvel Airdrop de test…"
for C in "$L" "$G"; do
  K=$($AIDE cfg "$C")
  if [ "$(get "$K" payAirdrop)" = "$AH" ]; then echo "      $C : déjà fait."; continue; fi
  A3="[\"$(get "$K" payOwner)\",\"$(get "$K" payCollab)\",\"$AH\"]"
  echo "      $C : setPayouts $A3"
  if oui "      ⚠️  Envoyer setPayouts depuis main ?"; then asentum call "$C" setPayouts --from main --args "$A3"; echo -n "      Attente…"; attendre_cfg "$C" payAirdrop "$AH"; fi
done

echo "[4/4] Croupiers et site de test…"
echo "$OA" >> .test-airdrop-ancien; echo "$OR" >> .test-raffle-ancien
echo "$A" > .test-airdrop; echo "$F" > .test-raffle; echo "$F" > .test-lots-fini
setvar TEST_AIRDROP_CONTRACT "$A"; setvar TEST_RAFFLE_CONTRACT "$F"
echo "      GitHub : TEST_AIRDROP_CONTRACT = $A, TEST_RAFFLE_CONTRACT = $F"
bash outils/mettre-en-ligne-test.sh
gh workflow run croupier-test.yml --repo "$R" >/dev/null 2>&1 || true
echo
echo "Nouvelle Raffle de test : $F · Nouvel Airdrop de test : $A"
echo "Site de test : https://asevegas-test.pages.dev   (les vrais jeux n'ont pas changé)"
