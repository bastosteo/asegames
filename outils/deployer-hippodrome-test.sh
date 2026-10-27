#!/usr/bin/env bash
# HIPPODROME sur le SITE DE TEST d'ASE Vegas (asevegas-test.pages.dev).
# Déploie le contrat de test, prépare ses 2 croupiers GitHub (comptes et graines à part),
# puis remet le site de test en ligne avec la page Hippodrome. Le vrai site ne change pas.
# Lancé par "Hippodrome-test.bat". Relançable sans risque : rien n'est refait deux fois.
# ⚠️ Chaque transaction depuis "main" est demandée (o/n) avant.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"; HA="node outils/hippo-aide.mjs"; GH_AIDE="node croupier/github-aide.mjs"
T=croupier/data-test
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
get() { node -e "const v=JSON.parse(process.argv[1]||'null');console.log(v==null||v['$2']==null?'':v['$2'])" "$1"; }

npm install --prefix croupier --no-audit --no-fund --silent
[ -f .test-loto ] || { echo "ERREUR : le site de test n'est pas installé (.test-loto introuvable)."; exit 1; }
[ -f .loto-v4-fait ] || { echo "ERREUR : .loto-v4-fait introuvable."; exit 1; }
grep -q "fell" contrat/hippodrome.deploy.js || { echo "ERREUR : contrat/hippodrome.deploy.js absent ou ancien (zip pas extrait ?)."; exit 1; }
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || { echo "ERREUR : GitHub non connecté (lance Installer-croupiers-GitHub.bat)."; exit 1; }
R="$(gh api user --jq .login)/asegames"
PAY_OWNER=$(get "$($AIDE cfg "$(cat .loto-v4-fait)")" payOwner)
[ -n "$PAY_OWNER" ] || { echo "ERREUR : wallet owner introuvable."; exit 1; }

echo "[1/6] Comptes et graines des 2 croupiers de l'Hippodrome (sur ce PC ; à sauvegarder avec les autres)…"
mkdir -p "$T"
$GH_AIDE signers "$T/hippo-signers.json" > /tmp/hippo-signers.txt
A_ASE1=$(awk '$1=="owner"{print $2}' /tmp/hippo-signers.txt); B_ASE1=$(awk '$1=="collab"{print $2}' /tmp/hippo-signers.txt); rm -f /tmp/hippo-signers.txt
A_HEX=$($AIDE hex "$A_ASE1"); B_HEX=$($AIDE hex "$B_ASE1")
$HA graine "$T/hippo-a-seed.txt" > /dev/null; $HA graine "$T/hippo-b-seed.txt" > /dev/null
echo "      croupier A : $A_ASE1"
echo "      croupier B : $B_ASE1"

echo "[2/6] ASE des croupiers (caution de 1 ASE par course, rendue au tirage, + le gas)…"
for X in "$A_ASE1" "$B_ASE1"; do
  S=$($GH_AIDE balance "$X")
  if awk "BEGIN{exit !($S >= 3)}"; then echo "      $X a déjà $S ASE."
  elif oui "      ⚠️  Envoyer 5 ASE depuis main vers $X ?"; then
    asentum send --from main --to "$X" --amount 5
    echo -n "      Attente de la confirmation"
    for i in $(seq 1 36); do sleep 5; echo -n "."; S=$($GH_AIDE balance "$X"); awk "BEGIN{exit !($S >= 3)}" && break; done
    echo " ok"; sleep 10
  fi
done

echo "[3/6] Contrat Hippodrome de test…"
M=.test-hippodrome
if [ -f "$M" ]; then N=$(cat "$M"); echo "      déjà déployé : $N"
else
  N=""; [ -f "$M-contrat" ] && N=$(cat "$M-contrat")
  if [ -n "$N" ] && [ "$($HA existe "$N")" != "oui" ]; then echo "      Le déploiement précédent ($N) n'a pas été inclus par la chaîne : on recommence."; rm -f "$M-contrat"; N=""; fi
  if [ -z "$N" ]; then
    oui "      ⚠️  Déployer contrat/hippodrome.deploy.js ($(wc -c < contrat/hippodrome.deploy.js) octets) depuis main ?" || exit 1
    OUT=$(asentum deploy contrat/hippodrome.deploy.js --from main 2>&1) || true; echo "$OUT"
    N=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
    [ -n "$N" ] || { echo "ERREUR : adresse du contrat introuvable (le contrat est peut-être trop gros pour la chaîne : envoie-moi ce message)."; exit 1; }
    echo "$N" > "$M-contrat"
    echo -n "      Attente de l'inclusion… "; $HA attendre "$N" deploye || { rm -f "$M-contrat"; echo "ERREUR : le contrat n'a pas été créé. Rien d'autre n'a été envoyé. Envoie ce message à Claude."; exit 1; }
  fi
  if [ -z "$($HA cfg "$N")" ]; then
    echo "      init [owner $PAY_OWNER, croupier A $A_HEX, croupier B $B_HEX]"
    oui "      ⚠️  Envoyer init sur l'Hippodrome de test depuis main ?" || exit 1
    asentum call "$N" init --from main --args "[\"$PAY_OWNER\",\"$A_HEX\",\"$B_HEX\"]"
    echo -n "      Attente de la confirmation… "; $HA attendre "$N" initialise
  fi
  echo "$N" > "$M"; rm -f "$M-contrat"
fi
BOND=1000000000000000000
if [ "$(get "$($HA cfg "$N")" bond)" != "$BOND" ]; then
  oui "      ⚠️  Régler la caution des croupiers à 1 ASE (au lieu de 10) depuis main ?" && {
    asentum call "$N" set --from main --args "[\"bond\",\"$BOND\"]"
    echo -n "      Attente de la confirmation… "; $HA attendre "$N" caution "$BOND" || true; }
else echo "      caution des croupiers : 1 ASE (déjà fait)"; fi

echo "[4/6] Croupiers GitHub de l'Hippodrome (workflow hippodrome-test.yml)…"
set_secret() { gh secret set "$1" --repo "$R" >/dev/null; }
$GH_AIDE seed "$T/hippo-signers.json" owner  | set_secret TEST_HIPPO_A_SIGNER
$GH_AIDE seed "$T/hippo-signers.json" collab | set_secret TEST_HIPPO_B_SIGNER
tr -d '\n' < "$T/hippo-a-seed.txt" | set_secret TEST_HIPPO_A_SEED
tr -d '\n' < "$T/hippo-b-seed.txt" | set_secret TEST_HIPPO_B_SEED
setvar() { gh api -X PATCH "repos/$R/actions/variables/$1" -f name="$1" -f value="$2" >/dev/null 2>&1 || gh api -X POST "repos/$R/actions/variables" -f name="$1" -f value="$2" >/dev/null; }
setvar TEST_HIPPO_CONTRACT "$N"
echo "      GitHub : 4 secrets et la variable TEST_HIPPO_CONTRACT enregistrés."

echo "[5/6] Branchement de la page Hippodrome dans la mise en ligne du site de test…"
if ! grep -q "hippodrome-site-test.sh" outils/mettre-en-ligne-test.sh; then
  sed -i '/^setc loto /a [ -f .test-hippodrome ] \&\& bash outils/hippodrome-site-test.sh "$D"' outils/mettre-en-ligne-test.sh
fi
grep -q "hippodrome-site-test.sh" outils/mettre-en-ligne-test.sh && echo "      ok" || { echo "ERREUR : impossible de modifier outils/mettre-en-ligne-test.sh"; exit 1; }

echo "[6/6] Mise en ligne du site de test (et envoi du code des croupiers sur GitHub)…"
bash outils/mettre-en-ligne-test.sh
[ -d .git ] || echo "      ATTENTION : ~/loto-ase n'est pas relié à GitHub (.git absent) : les croupiers ne tourneront pas. Envoie ce message à Claude."
gh workflow run hippodrome-test.yml --repo "$R" >/dev/null 2>&1 || true
echo
echo "Hippodrome de test : https://asevegas-test.pages.dev/hippodrome/   (contrat $N)"
echo "Première course : au prochain créneau 18h, 19h, 20h, 21h ou 22h (heure de Paris), au moins 30 min après le passage des croupiers."
echo "Les vrais jeux (asevegas.com) n'ont pas changé."
