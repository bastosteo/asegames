#!/usr/bin/env bash
# HIPPODROME v3 (chevaux des joueurs) sur le SITE DE TEST (asevegas-test.pages.dev).
# Déploie 2 contrats : ÉCURIE (chevaux, soins, inscriptions, prime au propriétaire) et PARIS
# (paris des spectateurs), branche les 2 croupiers GitHub (mêmes comptes que la v2), puis
# remet le site de test en ligne avec la nouvelle page. Le vrai site ne change pas.
# Lancé par "Hippodrome-v3-test.bat". Relançable sans risque : rien n'est refait deux fois.
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
for f in contrat/ecurie.deploy.js contrat/paris.deploy.js croupier/hippodrome3.mjs; do [ -f "$f" ] || { echo "ERREUR : $f absent (zip pas extrait ?)."; exit 1; }; done
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || { echo "ERREUR : GitHub non connecté (lance Installer-croupiers-GitHub.bat)."; exit 1; }
R="$(gh api user --jq .login)/asegames"
PAY_OWNER=$(get "$($AIDE cfg "$(cat .loto-v4-fait)")" payOwner)
[ -n "$PAY_OWNER" ] || { echo "ERREUR : wallet owner introuvable."; exit 1; }

echo "[1/7] Comptes et graines des 2 croupiers (les mêmes que l'Hippodrome v2)…"
mkdir -p "$T"
$GH_AIDE signers "$T/hippo-signers.json" > /tmp/hippo-signers.txt
A_ASE1=$(awk '$1=="owner"{print $2}' /tmp/hippo-signers.txt); B_ASE1=$(awk '$1=="collab"{print $2}' /tmp/hippo-signers.txt); rm -f /tmp/hippo-signers.txt
A_HEX=$($AIDE hex "$A_ASE1"); B_HEX=$($AIDE hex "$B_ASE1")
$HA graine "$T/hippo-a-seed.txt" > /dev/null; $HA graine "$T/hippo-b-seed.txt" > /dev/null
echo "      croupier A : $A_ASE1"
echo "      croupier B : $B_ASE1"

echo "[2/7] ASE des croupiers (cautions de 1 ASE rendues au tirage, + le gas)…"
for X in "$A_ASE1" "$B_ASE1"; do
  S=$($GH_AIDE balance "$X")
  if awk "BEGIN{exit !($S >= 4)}"; then echo "      $X a déjà $S ASE."
  elif oui "      ⚠️  Envoyer 6 ASE depuis main vers $X ?"; then
    asentum send --from main --to "$X" --amount 6
    echo -n "      Attente de la confirmation"
    for i in $(seq 1 36); do sleep 5; echo -n "."; S=$($GH_AIDE balance "$X"); awk "BEGIN{exit !($S >= 4)}" && break; done
    echo " ok"; sleep 10
  fi
done

# deployer <nom> <fichier> <marqueur> : déploie + init (owner, croupier A, croupier B), une seule fois
deployer() {
  local NOM="$1" F="$2" M="$3" N=""
  if [ -f "$M" ]; then echo "      $NOM déjà déployé : $(cat "$M")"; return; fi
  [ -f "$M-contrat" ] && N=$(cat "$M-contrat")
  if [ -n "$N" ] && [ "$($HA existe "$N")" != "oui" ]; then echo "      Le déploiement précédent ($N) n'a pas été inclus par la chaîne : on recommence."; rm -f "$M-contrat"; N=""; fi
  if [ -z "$N" ]; then
    oui "      ⚠️  Déployer le contrat $NOM ($F, $(wc -c < "$F") octets) depuis main ?" || exit 1
    local OUT; OUT=$(asentum deploy "$F" --from main 2>&1) || true; echo "$OUT"
    N=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
    [ -n "$N" ] || { echo "ERREUR : adresse du contrat $NOM introuvable. Envoie ce message à Claude."; exit 1; }
    echo "$N" > "$M-contrat"
    echo -n "      Attente de l'inclusion… "; $HA attendre "$N" deploye || { rm -f "$M-contrat"; echo "ERREUR : le contrat $NOM n'a pas été créé. Relance le .bat."; exit 1; }
  fi
  if [ -z "$($HA cfg "$N")" ]; then
    echo "      init $NOM [owner $PAY_OWNER, croupier A $A_HEX, croupier B $B_HEX]"
    oui "      ⚠️  Envoyer init sur le contrat $NOM depuis main ?" || exit 1
    asentum call "$N" init --from main --args "[\"$PAY_OWNER\",\"$A_HEX\",\"$B_HEX\"]"
    echo -n "      Attente de la confirmation… "; $HA attendre "$N" initialise
  fi
  echo "$N" > "$M"; rm -f "$M-contrat"
}

echo "[3/7] Contrat ÉCURIE (chevaux des joueurs)…"
deployer "Écurie" contrat/ecurie.deploy.js .test-hippo3-ecurie
NE=$(cat .test-hippo3-ecurie)

echo "[4/7] Contrat PARIS (paris des spectateurs)…"
deployer "Paris" contrat/paris.deploy.js .test-hippo3-paris
NP=$(cat .test-hippo3-paris)
BOND=1000000000000000000
if [ "$(get "$($HA cfg "$NP")" bond)" != "$BOND" ]; then
  oui "      ⚠️  Régler la caution des croupiers des Paris à 1 ASE (au lieu de 10) depuis main ?" && {
    asentum call "$NP" set --from main --args "[\"bond\",\"$BOND\"]"
    echo -n "      Attente de la confirmation… "; $HA attendre "$NP" caution "$BOND" || true; }
else echo "      caution des croupiers : 1 ASE (déjà fait)"; fi

echo "[5/7] Onglet Admin de la page…"
ADM_CFG=$(get "$($HA cfg "$NE")" admin)
if [ -f .test-hippo3-admin ]; then echo "      admin : $(cat .test-hippo3-admin) (déjà fait)"
else
  echo "      Pour voir l'onglet Admin sur la page, l'admin doit être le wallet que tu connectes sur le site"
  echo "      (extension ou Telegram). Colle son adresse ase1… ci-dessous, ou appuie sur Entrée pour garder main."
  read -r -p "      Adresse : " ADM
  if [ -n "$ADM" ]; then
    ADM_HEX=$($AIDE hex "$ADM") || { echo "ERREUR : adresse invalide."; exit 1; }
    if oui "      ⚠️  Donner l'admin des 2 contrats à $ADM (2 transactions depuis main ; ensuite main ne pourra plus changer les réglages) ?"; then
      asentum call "$NE" set --from main --args "[\"admin\",\"$ADM_HEX\"]"
      asentum call "$NP" set --from main --args "[\"admin\",\"$ADM_HEX\"]"
      echo "$ADM" > .test-hippo3-admin
    fi
  else echo "      admin gardé : main ($ADM_CFG)"; echo "main" > .test-hippo3-admin; fi
fi

echo "[6/7] Croupiers GitHub (workflow hippodrome-test.yml, version 3)…"
set_secret() { gh secret set "$1" --repo "$R" >/dev/null; }
$GH_AIDE seed "$T/hippo-signers.json" owner  | set_secret TEST_HIPPO_A_SIGNER
$GH_AIDE seed "$T/hippo-signers.json" collab | set_secret TEST_HIPPO_B_SIGNER
tr -d '\n' < "$T/hippo-a-seed.txt" | set_secret TEST_HIPPO_A_SEED
tr -d '\n' < "$T/hippo-b-seed.txt" | set_secret TEST_HIPPO_B_SEED
setvar() { gh api -X PATCH "repos/$R/actions/variables/$1" -f name="$1" -f value="$2" >/dev/null 2>&1 || gh api -X POST "repos/$R/actions/variables" -f name="$1" -f value="$2" >/dev/null; }
setvar TEST_HIPPO3_ECURIE "$NE"
setvar TEST_HIPPO3_PARIS "$NP"
echo "      GitHub : secrets et variables TEST_HIPPO3_ECURIE / TEST_HIPPO3_PARIS enregistrés."
if ! grep -q "hippodrome-site-test.sh" outils/mettre-en-ligne-test.sh; then
  sed -i '/^setc loto /a [ -f .test-hippodrome ] \&\& bash outils/hippodrome-site-test.sh "$D"' outils/mettre-en-ligne-test.sh
fi
sed -i 's#\[ -f .test-hippodrome \] \&\& bash outils/hippodrome-site-test.sh#{ [ -f .test-hippodrome ] || [ -f .test-hippo3-paris ]; } \&\& bash outils/hippodrome-site-test.sh#' outils/mettre-en-ligne-test.sh
grep -q "hippodrome-site-test.sh" outils/mettre-en-ligne-test.sh || { echo "ERREUR : impossible de modifier outils/mettre-en-ligne-test.sh"; exit 1; }

echo "[7/7] Mise en ligne du site de test (et envoi du code des croupiers sur GitHub)…"
bash outils/mettre-en-ligne-test.sh
[ -d .git ] || echo "      ATTENTION : ~/loto-ase n'est pas relié à GitHub (.git absent) : les croupiers ne tourneront pas. Envoie ce message à Claude."
gh workflow run hippodrome-test.yml --repo "$R" >/dev/null 2>&1 || true
echo
echo "Hippodrome v3 : https://asevegas-test.pages.dev/hippodrome/"
echo "   Écurie : $NE"
echo "   Paris  : $NP"
echo "Achète un cheval dans « My stable », nourris-le, inscris-le avant 18 h (Paris) : course à 19 h."
echo "Les vrais jeux (asevegas.com) n'ont pas changé."
