#!/usr/bin/env bash
# SITE DE TEST d'ASE Vegas : 4 NOUVEAUX contrats sur le testnet (Loto, Raffle, Treasure, Airdrop),
# séparés des vrais jeux, avec leurs propres chaînes de secrets, leurs propres croupiers GitHub
# (workflow croupier-test.yml, signataires de test) et leur propre site (Cloudflare : asevegas-test).
# Lancé par "Installer-site-test.bat". Relançable sans risque : rien n'est redéployé deux fois.
# ⚠️ Chaque transaction depuis "main" est demandée (o/n) avant.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
GH_AIDE="node croupier/github-aide.mjs"
W="npx --yes wrangler@3"
T=croupier/data-test
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
get() { node -e "const v=JSON.parse(process.argv[1]);console.log(v==null||v['$2']==null?'':v['$2'])" "$1"; }
tipOf() { node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).values.at(-1))" "$1"; }

npm install --prefix croupier --no-audit --no-fund --silent
for f in .loto-v4-fait .tombola-v3-fait .tresor-v2-fait; do [ -f "$f" ] || { echo "ERREUR : $f introuvable."; exit 1; }; done
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || { echo "ERREUR : GitHub non connecté (lance Installer-croupiers-GitHub.bat)."; exit 1; }
for n in loto tombola tresor airdrop; do
  grep -q dropBps contrat/$n.deploy.js || [ $n = airdrop ] || { echo "ERREUR : contrat/$n.deploy.js n'est pas la nouvelle version (ancien zip ?)."; exit 1; }
done
grep -q payRest contrat/airdrop.deploy.js || { echo "ERREUR : contrat/airdrop.deploy.js n'est pas la nouvelle version (ancien zip ?)."; exit 1; }
R="$(gh api user --jq .login)/asegames"
LC=$($AIDE cfg "$(cat .loto-v4-fait)"); RC=$($AIDE cfg "$(cat .tombola-v3-fait)"); TC=$($AIDE cfg "$(cat .tresor-v2-fait)")
PAY_OWNER=$(get "$LC" payOwner); PAY_COLLAB=$(get "$LC" payCollab); COLLAB_ADMIN=$(get "$LC" collabAdmin)

echo "[1/7] Secrets du site de test (sur ce PC ; à sauvegarder avec les autres)…"
mkdir -p "$T"
$GH_AIDE signers "$T/gh-signers.json" > /tmp/test-signers.txt
OPER_ASE1=$(awk '$1=="owner"{print $2}' /tmp/test-signers.txt); COLL_ASE1=$(awk '$1=="collab"{print $2}' /tmp/test-signers.txt); rm -f /tmp/test-signers.txt
OPER=$($AIDE hex "$OPER_ASE1")
for g in loto raffle airdrop; do
  for role in owner collab; do
    [ -f "$T/$g-$role/$role-chain.json" ] || { mkdir -p "$T/$g-$role"; ENV_FILE=/nonexistent DATA_DIR="$T/$g-$role" ROLE=$role node croupier/croupier.mjs chain-new > /dev/null; }
  done
done
[ -f "$T/tresor-seed.txt" ] || { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$T/tresor-seed.txt"; chmod 600 "$T/tresor-seed.txt"; }
echo "      chaînes et graine prêtes dans $T"
echo "      signataires de test : $OPER_ASE1 (owner) et $COLL_ASE1 (collab)"

echo "[2/7] Frais des signataires de test (ils paient seulement le gas des croupiers)…"
for A in "$OPER_ASE1" "$COLL_ASE1"; do
  S=$($GH_AIDE balance "$A")
  if awk "BEGIN{exit !($S >= 0.5)}"; then echo "      $A a déjà $S ASE."
  elif oui "      ⚠️  Envoyer 3 ASE depuis main vers $A ?"; then
    asentum send --from main --to "$A" --amount 3
    echo -n "      Attente de la confirmation (pour ne pas envoyer 2 transactions en même temps)"
    for i in $(seq 1 36); do sleep 5; echo -n "."; S=$($GH_AIDE balance "$A"); awk "BEGIN{exit !($S >= 0.5)}" && break; done
    echo " ok"; sleep 10
  fi
done

# déploie + init (idempotent) ; $1 = nom, $2 = fichier, $3 = args init (JSON)
deployer() {
  local NAME=$1 FILE=$2 ARGS=$3 M=".test-$1" N=""
  [ -f "$M" ] && { cat "$M"; return; }
  [ -f "$M-contrat" ] && N=$(cat "$M-contrat")
  if [ -z "$N" ]; then
    oui "      ⚠️  Déployer $FILE ($(wc -c < "$FILE") octets) depuis main ?" >&2 || exit 1
    local OUT; OUT=$(asentum deploy "$FILE" --from main 2>&1) || true; echo "$OUT" >&2
    N=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
    [ -n "$N" ] || { echo "ERREUR : adresse du contrat introuvable." >&2; exit 1; }
    echo "$N" > "$M-contrat"
    echo -n "      Attente de l'inclusion… " >&2; $AIDE attendre "$N" deploye >&2
  fi
  if [ -z "$(get "$($AIDE cfg "$N")" admin)" ]; then
    echo "      init $ARGS" >&2
    oui "      ⚠️  Envoyer init sur $NAME de test ($N) depuis main ?" >&2 || exit 1
    asentum call "$N" init --from main --args "$ARGS" >&2
    echo -n "      Attente de la confirmation… " >&2; $AIDE attendre "$N" initialise >&2
  fi
  echo "$N" > "$M"; rm -f "$M-contrat"; echo "$N"
}
reglage() {   # $1 = contrat, $2 = méthode, $3 = args, $4 = explication, $5 = clé à vérifier, $6 = valeur attendue
  [ "$(get "$($AIDE cfg "$1")" "$5")" = "$6" ] && { echo "      $4 : déjà fait."; return; }
  echo "      $2 $3   ($4)"
  oui "      ⚠️  Envoyer $2 depuis main ?" || return 0
  asentum call "$1" "$2" --from main --args "$3"
  for i in $(seq 1 24); do sleep 5; [ "$(get "$($AIDE cfg "$1")" "$5")" = "$6" ] && break; done
}

echo "[3/7] Airdrop de test (top 3 + lots de 20 ASE)…"
A=$(deployer airdrop contrat/airdrop.deploy.js "[\"$OPER\",\"$COLLAB_ADMIN\",\"$(tipOf $T/airdrop-owner/owner-chain.json)\",\"$(tipOf $T/airdrop-collab/collab-chain.json)\"]")
AH=$($AIDE hex "$A"); echo "      Airdrop de test : $A"

echo "[4/7] Loto de test (5 sur 15, 15 grilles par joueur, commission 9 % équipe / 6 % Airdrop)…"
L=$(deployer loto contrat/loto.deploy.js "[\"$PAY_OWNER\",\"$PAY_COLLAB\",\"$COLLAB_ADMIN\",\"$(tipOf $T/loto-owner/owner-chain.json)\",\"$(tipOf $T/loto-collab/collab-chain.json)\",\"$AH\"]")
echo "      Loto de test : $L"
reglage "$L" setConfig "[\"$(get "$LC" price)\",$(get "$LC" drawH),$(get "$LC" drawM),$(get "$LC" maxGrids),$(get "$LC" closeMin),$(get "$LC" revealMin),2000,15,15]" "mêmes prix et horaires que le vrai Loto, 15 numéros, 2 000 grilles, 15 par joueur" closeMin "$(get "$LC" closeMin)"

echo "[5/7] Raffle de test (dimanche, mardi, jeudi ; top 3 + lots de 100 ASE)…"
F=$(deployer raffle contrat/tombola.deploy.js "[\"$PAY_OWNER\",\"$PAY_COLLAB\",\"$COLLAB_ADMIN\",\"$(tipOf $T/raffle-owner/owner-chain.json)\",\"$(tipOf $T/raffle-collab/collab-chain.json)\",\"$AH\"]")
echo "      Raffle de test : $F"
reglage "$F" setConfig "[\"$(get "$RC" price)\",21,$(get "$RC" drawH),$(get "$RC" drawM),10,$(get "$RC" closeMin),$(get "$RC" revealMin),$(get "$RC" maxRound)]" "même prix, dim + mar + jeu, 10 tickets par wallet" closeMin "$(get "$RC" closeMin)"

echo "[6/7] Treasure de test…"
G=$(deployer tresor contrat/tresor.deploy.js "[\"$OPER\",\"$PAY_OWNER\",\"$PAY_COLLAB\",\"$AH\"]")
echo "      Treasure de test : $G"
reglage "$G" setConfig "[\"$(get "$TC" price)\",$(get "$TC" maxPerWallet)]" "même prix que le vrai Treasure" price "$(get "$TC" price)"

echo "[7/7] Croupiers GitHub (workflow croupier-test.yml) et site de test…"
set_secret() { gh secret set "$1" --repo "$R" >/dev/null; }
$GH_AIDE seed "$T/gh-signers.json" owner  | set_secret TEST_OWNER_SIGNER_SEED
$GH_AIDE seed "$T/gh-signers.json" collab | set_secret TEST_COLLAB_SIGNER_SEED
$GH_AIDE chainseed "$T/loto-owner/owner-chain.json"     | set_secret TEST_OWNER_CHAIN_SEED
$GH_AIDE chainseed "$T/loto-collab/collab-chain.json"   | set_secret TEST_COLLAB_CHAIN_SEED
$GH_AIDE chainseed "$T/raffle-owner/owner-chain.json"   | set_secret TEST_RAFFLE_OWNER_CHAIN_SEED
$GH_AIDE chainseed "$T/raffle-collab/collab-chain.json" | set_secret TEST_RAFFLE_COLLAB_CHAIN_SEED
$GH_AIDE chainseed "$T/airdrop-owner/owner-chain.json"  | set_secret TEST_AIRDROP_OWNER_CHAIN_SEED
$GH_AIDE chainseed "$T/airdrop-collab/collab-chain.json" | set_secret TEST_AIRDROP_COLLAB_CHAIN_SEED
tr -d '\n' < "$T/tresor-seed.txt" | set_secret TEST_TREASURE_SEED
setvar() { gh api -X PATCH "repos/$R/actions/variables/$1" -f name="$1" -f value="$2" >/dev/null 2>&1 || gh api -X POST "repos/$R/actions/variables" -f name="$1" -f value="$2" >/dev/null; }
setvar TEST_CONTRACT "$L"; setvar TEST_RAFFLE_CONTRACT "$F"; setvar TEST_TREASURE_CONTRACT "$G"; setvar TEST_AIRDROP_CONTRACT "$A"
echo "      GitHub : secrets et variables de test enregistrés."
bash outils/mettre-en-ligne-test.sh
gh workflow run croupier-test.yml --repo "$R" >/dev/null 2>&1 || true
echo
echo "Site de test : https://asevegas-test.pages.dev  (Loto $L · Raffle $F · Treasure $G · Airdrop $A)"
echo "Les vrais jeux (asevegas.com) n'ont pas changé."
