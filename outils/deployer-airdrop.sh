#!/usr/bin/env bash
# ASE Airdrop + nouvelles versions du loto (v3) et de la tombola (v2), commission 15 %.
# Lancé par "Deployer-ASE-Airdrop.bat".
#  1. termine proprement les anciens contrats (pause, remboursement du tirage en cours,
#     envoi des gains pas encore réclamés à leurs gagnants) ;
#  2. déploie et initialise l'Airdrop, puis le loto v3 et la tombola v2 ;
#  3. met à jour le site, les croupiers (GitHub et PC) et remet le site en ligne.
# ⚠️ Chaque transaction (depuis ton compte "main") est demandée (o/n) avant d'être envoyée.
# Peut être relancé sans risque : il ne redéploie jamais un contrat déjà en place.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
MIG="node outils/migration.mjs"
GH_AIDE="node croupier/github-aide.mjs"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
DO="croupier/data-airdrop"; DC="croupier/data-airdrop-collab"

npm install --prefix croupier --no-audit --no-fund --silent

# Anciens contrats (adresses gardées sur ce PC)
[ -f .loto-v2-fait ] || { echo "ERREUR : fichier .loto-v2-fait introuvable (adresse de l'ancien loto)."; exit 1; }
[ -f .tombola-fait ] || { echo "ERREUR : fichier .tombola-fait introuvable (adresse de l'ancienne tombola)."; exit 1; }
OLD_LOTO=$(cat .loto-v2-fait); OLD_RAFFLE=$(cat .tombola-fait)

# Termine un ancien contrat : une transaction à la fois, chacune demandée avant.
migrer() { # $1 = contrat, $2 = loto|raffle, $3 = nom
  if [ -f ".migre-$2" ]; then echo "      Déjà fait."; return; fi
  while :; do
    LINE=$($MIG plan "$1" "$2" | head -1)
    [ -z "$LINE" ] && break
    IFS=$'\t' read -r M A D <<< "$LINE"
    if [ "$M" = "ATTENTE" ]; then
      echo "      ⏳ $3 : $A."
      echo "      Rien d'autre n'a été envoyé. Relance ce fichier dans 30 minutes environ."
      exit 3
    fi
    echo "      → $D"
    oui "      ⚠️  Envoyer $M $A sur l'ancien contrat ($3) depuis main ?" || { echo "      Arrêt demandé : rien d'autre n'a été envoyé."; exit 1; }
    asentum call "$1" "$M" --from main --args "$A"
    echo -n "      Attente de la confirmation… "; $MIG attendre "$1" "$2" "$M" "$A"
  done
  touch ".migre-$2"
  echo "      $3 : terminé (en pause, plus rien en attente)."
}

est_initialise() { node -e "fetch((process.env.RPC_URL||'https://testnet.asentum.com')+'/view',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contract:'$1',method:'getConfig',args:[]})}).then(r=>r.json()).then(j=>process.exit(j.returnValue?0:1)).catch(()=>process.exit(1))"; }

# Déploie puis initialise un contrat. Résultat (adresse) dans RES.
deployer() { # $1 = nom, $2 = fichier, $3 = marqueur, $4 = arguments de init (JSON)
  local nom="$1" f="$2" m="$3" args="$4" N=""
  if [ -f ".$m-fait" ]; then RES=$(cat ".$m-fait"); echo "      $nom déjà en place : $RES"; return; fi
  [ -f ".$m-contrat" ] && N=$(cat ".$m-contrat")
  if [ -z "$N" ]; then
    oui "      ⚠️  Déployer $nom ($f, $(wc -c < "$f") octets) depuis main ?" || exit 1
    OUT=$(asentum deploy "$f" --from main 2>&1) || true; echo "$OUT"
    N=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
    [ -n "$N" ] || { echo "ERREUR : adresse du contrat introuvable dans la sortie ci-dessus."; exit 1; }
    echo "$N" > ".$m-contrat"
    echo -n "      Attente de l'inclusion… "; $AIDE attendre "$N" deploye
  else
    echo "      $nom déjà déployé : $N"
  fi
  if est_initialise "$N"; then echo "      Déjà initialisé."
  else
    echo "      init $args"
    oui "      ⚠️  Envoyer init sur $N depuis main ?" || exit 1
    asentum call "$N" init --from main --args "$args"
    echo -n "      Attente de la confirmation… "; $AIDE attendre "$N" initialise
  fi
  echo "$N" > ".$m-fait"; rm -f ".$m-contrat"
  RES="$N"
}

echo "[1/8] Ancien loto ($OLD_LOTO)…"
migrer "$OLD_LOTO" loto "ancien loto"
echo "[2/8] Ancienne tombola ($OLD_RAFFLE)…"
migrer "$OLD_RAFFLE" raffle "ancienne tombola"

# Réglages repris des anciens contrats (mêmes wallets, mêmes chaînes de secrets)
LI=$($AIDE info "$OLD_LOTO"); RI=$($AIDE info "$OLD_RAFFLE")
get() { node -e "console.log(JSON.parse(process.argv[1])['$2'])" "$1"; }
PAY_OWNER=$(get "$LI" payOwner); PAY_COLLAB=$(get "$LI" payCollab); COLLAB_ADMIN=$(get "$LI" collabAdmin)
[ -f croupier/data/gh-signers.json ] || { echo "ERREUR : croupier/data/gh-signers.json introuvable (lance d'abord Installer-croupiers-GitHub.bat)."; exit 1; }
OPERATOR=$($AIDE hex "$($GH_AIDE signers croupier/data/gh-signers.json | awk '$1=="owner"{print $2}')")
echo "      commission : owner (75 %) $PAY_OWNER, collaborateur (25 %) $PAY_COLLAB"
echo "      opérateur de l'Airdrop (croupier owner GitHub) : $OPERATOR"

echo "[3/8] Chaînes de secrets de l'Airdrop (sur ce PC)…"
mkdir -p "$DO" "$DC"
[ -f "$DO/owner-chain.json" ] || ENV_FILE=/nonexistent DATA_DIR="$DO" ROLE=owner node croupier/croupier.mjs chain-new > /dev/null
[ -f "$DC/collab-chain.json" ] || ENV_FILE=/nonexistent DATA_DIR="$DC" ROLE=collab node croupier/croupier.mjs chain-new > /dev/null
TIPO=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DO/owner-chain.json')).values.at(-1))")
TIPC=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DC/collab-chain.json')).values.at(-1))")
echo "      chaînes prêtes (à sauvegarder avec les autres : $DO et $DC)"

echo "[4/8] Contrat ASE Airdrop…"
deployer "l'ASE Airdrop" contrat/airdrop.deploy.js airdrop "[\"$OPERATOR\",\"$COLLAB_ADMIN\",\"$TIPO\",\"$TIPC\"]"
AIRDROP="$RES"; DROP_HEX=$($AIDE hex "$AIRDROP")

echo "[5/8] Nouveau loto (v3, commission 15 %)…"
deployer "le loto v3" contrat/loto.deploy.js loto-v3 "[\"$PAY_OWNER\",\"$PAY_COLLAB\",\"$COLLAB_ADMIN\",\"$(get "$LI" tipO)\",\"$(get "$LI" tipC)\",\"$DROP_HEX\"]"
LOTO="$RES"
echo "      Nouvelle tombola (v2, commission 15 %)…"
deployer "la tombola v2" contrat/tombola.deploy.js tombola-v2 "[\"$(get "$RI" payOwner)\",\"$(get "$RI" payCollab)\",\"$(get "$RI" collabAdmin)\",\"$(get "$RI" tipO)\",\"$(get "$RI" tipC)\",\"$DROP_HEX\"]"
RAFFLE="$RES"

echo "[6/8] Site et croupiers pointent vers les nouveaux contrats…"
sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$LOTO'|" site/js/config.js
sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$RAFFLE'|" tombola/js/config.js
sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$AIRDROP'|" airdrop/js/config.js
sed -i "s/$OLD_LOTO/$LOTO/g" .github/workflows/croupier.yml
for f in croupier/.env croupier/.env.collab; do [ -f "$f" ] && sed -i "s/^CONTRACT=.*/CONTRACT=$LOTO/" "$f"; done
R=""
setvar() { gh api -X PATCH "repos/$R/actions/variables/$1" -f name="$1" -f value="$2" >/dev/null 2>&1 || gh api -X POST "repos/$R/actions/variables" -f name="$1" -f value="$2" >/dev/null; }
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  R="$(gh api user --jq .login)/asegames"
  $GH_AIDE chainseed "$DO/owner-chain.json"  | gh secret set AIRDROP_OWNER_CHAIN_SEED  --repo "$R"
  $GH_AIDE chainseed "$DC/collab-chain.json" | gh secret set AIRDROP_COLLAB_CHAIN_SEED --repo "$R"
  setvar CONTRACT "$LOTO"; setvar RAFFLE_CONTRACT "$RAFFLE"; setvar AIRDROP_CONTRACT "$AIRDROP"
  git add -A
  if git diff --cached --name-only | grep -E '(-chain\.json|gh-signers\.json|(^|/)\.env($|\.)|croupier/data)' | grep -v '\.env\.exemple$'; then
    echo "ERREUR : un fichier secret allait être publié. Arrêt."; exit 1
  fi
  git commit -qm "ASE Airdrop + loto v3 + raffle v2 (15% fee, half to the weekly airdrop)" || true
  git push -q
  echo "      GitHub à jour : les croupiers gèrent le loto, la tombola ET l'Airdrop."
else
  echo "⚠️  GitHub non connecté : lance Installer-croupiers-GitHub.bat, puis relance ce fichier."
fi

echo "[7/8] Mise en ligne du site…"
bash outils/mettre-en-ligne.sh

echo "[8/8] Relance des croupiers…"
if systemctl list-unit-files 2>/dev/null | grep -q '^loto-croupier'; then
  echo "      (mot de passe Linux demandé)"
  sudo systemctl restart loto-croupier loto-croupier-collab 2>/dev/null || true
fi
[ -n "$R" ] && gh workflow run croupier.yml --repo "$R" >/dev/null 2>&1 || true
echo
echo "ASE Airdrop : $AIRDROP"
echo "ASE Loto    : $LOTO"
echo "ASE Raffle  : $RAFFLE"
echo "Site : https://asegame.pages.dev/airdrop/"
