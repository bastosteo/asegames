#!/usr/bin/env bash
# SITE DE TEST : remplace le Loto de test par le nouveau Loto (numéros, plafond par tirage et par joueur
# réglables dans le panneau Admin). Lancé par "Nouveau-Loto-test.bat". Ne touche pas aux vrais jeux.
# ⚠️ Chaque transaction depuis "main" est demandée (o/n) avant. Relançable sans risque.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
T=croupier/data-test
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
get() { node -e "const v=JSON.parse(process.argv[1]);console.log(v==null||v['$2']==null?'':v['$2'])" "$1"; }
tipOf() { node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).values.at(-1))" "$1"; }

npm install --prefix croupier --no-audit --no-fund --silent
grep -q skim contrat/loto.deploy.js && { echo "ERREUR : contrat/loto.deploy.js contient le prélèvement (ancien zip ?)."; exit 1; }
grep -q nextMaxn contrat/loto.deploy.js || { echo "ERREUR : contrat/loto.deploy.js n'est pas le nouveau Loto (ancien zip ?)."; exit 1; }
for n in loto raffle tresor airdrop; do
  [ -f ".test-$n" ] || { echo "Le site de test n'est pas encore installé : lance \"Installer-site-test.bat\" (il installe directement le nouveau Loto)."; exit 1; }
done
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || { echo "ERREUR : GitHub non connecté."; exit 1; }
R="$(gh api user --jq .login)/asegames"
OL=$(cat .test-loto)
if [ -n "$(get "$($AIDE cfg "$OL")" maxWallet)" ] && [ -n "$(get "$($AIDE info "$OL")" roundMaxn)" ]; then
  echo "Le Loto de test est déjà le nouveau Loto ($OL)."; echo "Site de test : https://asevegas-test.pages.dev/loto/"; exit 0
fi
echo "Loto de test actuel (ancienne version) : $OL"
LI=$($AIDE info "$OL"); LC=$($AIDE cfg "$OL"); AH=$($AIDE hex "$(cat .test-airdrop)")

echo "[1/3] Nouveau Loto de test…"
N=""; [ -f .test-loto2-contrat ] && N=$(cat .test-loto2-contrat)
if [ -z "$N" ]; then
  oui "      ⚠️  Déployer le nouveau Loto de test (contrat/loto.deploy.js, $(wc -c < contrat/loto.deploy.js) octets) depuis main ?" || exit 1
  OUT=$(asentum deploy contrat/loto.deploy.js --from main 2>&1) || true; echo "$OUT"
  N=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
  [ -n "$N" ] || { echo "ERREUR : adresse du contrat introuvable dans la sortie ci-dessus."; exit 1; }
  echo "$N" > .test-loto2-contrat
  echo -n "      Attente de l'inclusion… "; $AIDE attendre "$N" deploye
else echo "      Déjà déployé : $N"; fi
if [ -z "$(get "$($AIDE cfg "$N")" admin)" ]; then
  TO=$(get "$LI" tipO); TC=$(get "$LI" tipC)
  [ -n "$TO" ] || TO=$(tipOf $T/loto-owner/owner-chain.json); [ -n "$TC" ] || TC=$(tipOf $T/loto-collab/collab-chain.json)
  A="[\"$(get "$LC" payOwner)\",\"$(get "$LC" payCollab)\",\"$(get "$LC" collabAdmin)\",\"$TO\",\"$TC\",\"$AH\"]"
  echo "      init $A"
  oui "      ⚠️  Envoyer init sur le nouveau Loto de test depuis main ?" || exit 1
  asentum call "$N" init --from main --args "$A"
  echo -n "      Attente de la confirmation… "; $AIDE attendre "$N" initialise
else echo "      Déjà initialisé."; fi
C=$($AIDE cfg "$N")
if [ "$(get "$C" price)" = "$(get "$LC" price)" ] && [ "$(get "$C" closeMin)" = "$(get "$LC" closeMin)" ] && [ "$(get "$C" drawH)" = "$(get "$LC" drawH)" ]; then echo "      Déjà réglé."
else
  A="[\"$(get "$LC" price)\",$(get "$LC" drawH),$(get "$LC" drawM),15,$(get "$LC" closeMin),$(get "$LC" revealMin),2000,15,15]"
  echo "      setConfig $A   (même prix et horaires ; 15 numéros, 2 000 grilles par tirage, 15 par joueur)"
  oui "      ⚠️  Envoyer setConfig sur le nouveau Loto de test depuis main ?" || exit 1
  asentum call "$N" setConfig --from main --args "$A"
  echo -n "      Attente de la confirmation…"
  for i in $(seq 1 36); do sleep 5; [ "$(get "$($AIDE cfg "$N")" closeMin)" = "$(get "$LC" closeMin)" ] && { echo " ok"; break; }; echo -n "."; done
fi
if [ "$(get "$($AIDE cfg "$OL")" paused)" != "true" ]; then
  if oui "      ⚠️  Mettre l'ancien Loto de test en pause (setPaused [true]) depuis main ?"; then
    asentum call "$OL" setPaused --from main --args '[true]' || true
  fi
fi

echo "[2/3] Croupiers de test (GitHub) sur le nouveau Loto…"
echo "$OL" >> .test-loto-ancien; echo "$N" > .test-loto; rm -f .test-loto2-contrat
setvar() { gh api -X PATCH "repos/$R/actions/variables/$1" -f name="$1" -f value="$2" >/dev/null 2>&1 || gh api -X POST "repos/$R/actions/variables" -f name="$1" -f value="$2" >/dev/null; }
setvar TEST_CONTRACT "$N"
echo "      GitHub : TEST_CONTRACT = $N"

echo "[3/3] Site de test…"
bash outils/mettre-en-ligne-test.sh
gh workflow run croupier-test.yml --repo "$R" >/dev/null 2>&1 || true
echo
echo "Nouveau Loto de test : $N"
echo "Site de test : https://asevegas-test.pages.dev/loto/   (les vrais jeux n'ont pas changé)"
