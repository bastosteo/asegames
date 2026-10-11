#!/usr/bin/env bash
# Installe ASE Raffle (tombola hebdomadaire) : chaînes de secrets, contrat, croupiers GitHub, site.
# Lancé par "Deployer-tombola.bat". ⚠️ 2 transactions depuis "main" (déploiement + init), demandées avant.
# Peut être relancé sans risque : il ne redéploie jamais un contrat déjà en place.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="${AIDE:-node outils/loto-aide.mjs}"
GH_AIDE="node croupier/github-aide.mjs"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
PAY_COLLAB_ASE1="ase1ludcdjwrnfdfl6wujdahvkrsxst6vtve7qs3kw"
DO="croupier/data-tombola"; DC="croupier/data-tombola-collab"

npm install --prefix croupier --no-audit --no-fund --silent
LOTO=$(grep -o "ase1[0-9a-z]\{38\}" site/js/config.js | head -1)
[ -f .tombola-contrat ] && NEW=$(cat .tombola-contrat) || NEW=""
[ -f .tombola-fait ] && NEW=$(cat .tombola-fait)

if [ ! -f .tombola-fait ]; then
  echo "[1/6] Réglages repris du loto ($LOTO)…"
  INFO=$($AIDE info "$LOTO") || { echo "ERREUR : le loto n'est pas lisible. Lance d'abord Deployer-nouveau-loto.bat jusqu'au bout."; exit 1; }
  get() { node -e "console.log(JSON.parse(process.argv[1])['$1'])" "$INFO"; }
  PAY_OWNER=$(get payOwner); COLLAB_ADMIN=$(get collabAdmin)
  PAY_COLLAB=$($AIDE hex "$PAY_COLLAB_ASE1")
  echo "      commission owner (75 %) : $PAY_OWNER"
  echo "      commission collab (25 %): $PAY_COLLAB"

  echo "[2/6] Deux nouvelles chaînes de secrets pour la tombola (sur ce PC)…"
  mkdir -p "$DO" "$DC"
  ENV_FILE=/nonexistent DATA_DIR="$DO" ROLE=owner node croupier/croupier.mjs chain-new > /dev/null
  ENV_FILE=/nonexistent DATA_DIR="$DC" ROLE=collab node croupier/croupier.mjs chain-new > /dev/null
  TIPO=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DO/owner-chain.json')).values.at(-1))")
  TIPC=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DC/collab-chain.json')).values.at(-1))")
  echo "      chaînes prêtes (à sauvegarder avec les autres : $DO et $DC)"

  if [ -z "$NEW" ]; then
    echo "[3/6] Déploiement du contrat de la tombola ($(wc -c < contrat/tombola.deploy.js) octets)…"
    oui "      ⚠️  Déployer contrat/tombola.deploy.js depuis main ?" || exit 1
    OUT=$(asentum deploy contrat/tombola.deploy.js --from main 2>&1 | tee /dev/stderr)
    NEW=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
    [ -n "$NEW" ] || { echo "ERREUR : adresse du contrat introuvable dans la sortie ci-dessus."; exit 1; }
    echo "$NEW" > .tombola-contrat
    echo -n "      Attente de l'inclusion… "; $AIDE attendre "$NEW" deploye
  else
    echo "[3/6] Contrat déjà déployé : $NEW"
  fi

  echo "[4/6] Initialisation…"
  ARGS="[\"$PAY_OWNER\",\"$PAY_COLLAB\",\"$COLLAB_ADMIN\",\"$TIPO\",\"$TIPC\"]"
  oui "      ⚠️  Envoyer init sur $NEW depuis main ?" || exit 1
  asentum call "$NEW" init --from main --args "$ARGS"
  echo -n "      Attente de la confirmation… "; $AIDE attendre "$NEW" initialise
  echo "$NEW" > .tombola-fait; rm -f .tombola-contrat
else
  echo "La tombola est déjà en place ($NEW) : simple remise à jour du site et de GitHub."
fi

echo "[5/6] Site et croupiers GitHub…"
sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$NEW'|" tombola/js/config.js
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  R="$(gh api user --jq .login)/asegames"
  $GH_AIDE chainseed "$DO/owner-chain.json"  | gh secret set RAFFLE_OWNER_CHAIN_SEED  --repo "$R"
  $GH_AIDE chainseed "$DC/collab-chain.json" | gh secret set RAFFLE_COLLAB_CHAIN_SEED --repo "$R"
  gh api -X PATCH "repos/$R/actions/variables/RAFFLE_CONTRACT" -f name=RAFFLE_CONTRACT -f value="$NEW" >/dev/null 2>&1 \
    || gh api -X POST "repos/$R/actions/variables" -f name=RAFFLE_CONTRACT -f value="$NEW" >/dev/null
  git add -A
  if git diff --cached --name-only | grep -E '(-chain\.json|gh-signers\.json|(^|/)\.env($|\.)|croupier/data)' | grep -v '\.env\.exemple$'; then
    echo "ERREUR : un fichier secret allait être publié. Arrêt."; exit 1
  fi
  git commit -qm "ASE Raffle : tombola hebdomadaire" || true
  git push -q
  gh workflow run croupier.yml --repo "$R" >/dev/null 2>&1 || true
  echo "      GitHub à jour : les croupiers gèrent maintenant le loto ET la tombola."
else
  echo "⚠️  GitHub non connecté : lance d'abord Installer-croupiers-GitHub.bat, puis relance ce fichier."
fi

echo "[6/6] Mise en ligne du site…"
bash outils/mettre-en-ligne.sh
echo
echo "ASE Raffle : $NEW"
echo "Site : https://asevegas.pages.dev/raffle/"
