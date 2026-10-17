#!/usr/bin/env bash
# Installe les croupiers d'ASE Loto sur GitHub Actions (gratuit, tourne même PC éteint).
# Lancé par "Installer-croupiers-GitHub.bat" sous Windows, ou directement dans WSL.
# Ce script ne montre jamais les graines : elles vont directement du PC vers les secrets GitHub.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
REPO_NAME="asegames"
SIGNERS="croupier/data/gh-signers.json"
AIDE="node croupier/github-aide.mjs"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }

echo "[1/8] Outils (git, gh, librairies du croupier)…"
if ! command -v gh >/dev/null || ! command -v git >/dev/null; then
  echo "      Installation de git et gh : ton mot de passe Linux (WSL) va être demandé."
  sudo apt-get update -qq
  if ! sudo apt-get install -y -qq git gh; then
    # Ancienne Debian : on ajoute le dépôt officiel de GitHub CLI
    sudo apt-get install -y -qq git curl
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    sudo apt-get update -qq && sudo apt-get install -y -qq gh
  fi
fi
npm install --prefix croupier --no-audit --no-fund --silent

CONTRACT=$(grep -o "ase1[0-9a-z]\{38\}" site/js/config.js | head -1)
[ -n "$CONTRACT" ] || { echo "ERREUR : adresse du contrat introuvable dans site/js/config.js"; exit 1; }
export CONTRACT
echo "      Contrat : $CONTRACT"

echo "[2/8] Vérification des deux chaînes de secrets du PC…"
OWNER_CHAIN=$(find croupier -maxdepth 2 -name 'owner-chain.json' -not -path '*/node_modules/*' | head -1)
COLLAB_CHAIN=$(find croupier -maxdepth 2 -name 'collab-chain.json' -not -path '*/node_modules/*' | head -1)
[ -n "$OWNER_CHAIN" ] && [ -n "$COLLAB_CHAIN" ] || { echo "ERREUR : owner-chain.json ou collab-chain.json introuvable dans ~/loto-ase/croupier"; exit 1; }
$AIDE check "$OWNER_CHAIN" "$COLLAB_CHAIN"

echo "[3/8] Connexion à GitHub…"
if ! gh auth status >/dev/null 2>&1; then
  echo "      Un code va s'afficher. Ouvre https://github.com/login/device dans ton navigateur,"
  echo "      tape le code, puis clique sur Authorize. (Si on te demande d'appuyer sur Entrée, fais-le.)"
  BROWSER=false gh auth login --hostname github.com --git-protocol https --web --scopes workflow
fi
gh auth setup-git >/dev/null 2>&1 || true
LOGIN=$(gh api user --jq .login)
echo "      Connecté en tant que $LOGIN"

echo "[4/8] Comptes signataires des croupiers (ils paient seulement les frais)…"
mkdir -p croupier/data
$AIDE signers "$SIGNERS" > /tmp/gh-signers.txt
OWNER_ADDR=$(awk '$1=="owner"{print $2}' /tmp/gh-signers.txt)
COLLAB_ADDR=$(awk '$1=="collab"{print $2}' /tmp/gh-signers.txt)
rm -f /tmp/gh-signers.txt
echo "      owner  : $OWNER_ADDR"
echo "      collab : $COLLAB_ADDR"
echo "      (graines dans $SIGNERS : à sauvegarder avec tes chaînes, ne les donne à personne)"

echo "[5/8] Approvisionnement des signataires…"
envoyer() { # $1 = adresse
  local solde; solde=$($AIDE balance "$1")
  if awk "BEGIN{exit !($solde >= 0.5)}"; then echo "      $1 a déjà $solde ASE : rien à envoyer."; return; fi
  if oui "      ⚠️  Envoyer 2 ASE depuis ton compte main vers $1 ?"; then
    asentum send --from main --to "$1" --amount 2
    echo -n "      Attente de la confirmation"
    for _ in $(seq 1 24); do
      sleep 5; echo -n "."
      solde=$($AIDE balance "$1")
      if awk "BEGIN{exit !($solde >= 0.5)}"; then echo " reçu ($solde ASE)."; sleep 10; return; fi
    done
    echo " pas encore visible (ce n'est pas grave, ça arrivera)."
    sleep 30
  else
    echo "      D'accord, pas d'envoi. Le croupier ne pourra pas agir tant que ce compte est vide."
  fi
}
envoyer "$OWNER_ADDR"
envoyer "$COLLAB_ADDR"

echo "[6/8] Dépôt GitHub $LOGIN/$REPO_NAME…"
[ -d .git ] || git init -q -b main
git config user.name >/dev/null || git config user.name "$LOGIN"
git config user.email >/dev/null || git config user.email "$(gh api user --jq '.id')+$LOGIN@users.noreply.github.com"
git add -A
# Sécurité : aucun secret ne doit partir sur GitHub
if git diff --cached --name-only | grep -E '(-chain\.json|gh-signers\.json|(^|/)\.env($|\.)|croupier/data)' | grep -v '\.env\.exemple$'; then
  echo "ERREUR : un fichier secret allait être publié (voir ci-dessus). Arrêt, rien n'a été envoyé."; exit 1
fi
git commit -qm "ASE Vegas : loto, site et croupiers" || true
if gh repo view "$LOGIN/$REPO_NAME" >/dev/null 2>&1; then
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$LOGIN/$REPO_NAME.git"
  git push -q -u origin main
else
  gh repo create "$REPO_NAME" --public --source . --remote origin --push \
    --description "ASE Vegas : jeux sur le testnet Asentum (ASE Loto)" >/dev/null
fi
R="$LOGIN/$REPO_NAME"
echo "      https://github.com/$R"

echo "[7/8] Secrets et réglages du dépôt (envoyés directement, jamais affichés)…"
$AIDE seed "$SIGNERS" owner  | gh secret set OWNER_SIGNER_SEED  --repo "$R"
$AIDE seed "$SIGNERS" collab | gh secret set COLLAB_SIGNER_SEED --repo "$R"
$AIDE chainseed "$OWNER_CHAIN"  | gh secret set OWNER_CHAIN_SEED  --repo "$R"
$AIDE chainseed "$COLLAB_CHAIN" | gh secret set COLLAB_CHAIN_SEED --repo "$R"
TG_TOKEN=$(grep -s '^TELEGRAM_TOKEN=' croupier/.env | cut -d= -f2- || true)
TG_CHAT=$(grep -s '^TELEGRAM_CHAT_ID=' croupier/.env | cut -d= -f2- || true)
if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ]; then
  printf %s "$TG_TOKEN" | gh secret set TELEGRAM_TOKEN --repo "$R"
  printf %s "$TG_CHAT" | gh secret set TELEGRAM_CHAT_ID --repo "$R"
  echo "      Alertes Telegram activées."
fi
gh api -X PATCH "repos/$R/actions/variables/CONTRACT" -f name=CONTRACT -f value="$CONTRACT" >/dev/null 2>&1 \
  || gh api -X POST "repos/$R/actions/variables" -f name=CONTRACT -f value="$CONTRACT" >/dev/null

echo "[8/8] Premier passage des croupiers…"
gh workflow enable croupier.yml --repo "$R" >/dev/null 2>&1 || true
sleep 3
gh workflow run croupier.yml --repo "$R"
sleep 8
gh run list --repo "$R" --workflow croupier.yml --limit 1
echo
echo "Suivi : https://github.com/$R/actions"
# Les croupiers du PC (s'ils existent) restent en secours ; on les relance pour qu'ils prennent la nouvelle version.
if systemctl list-unit-files 2>/dev/null | grep -q '^loto-croupier'; then
  echo "Relance des croupiers du PC (secours) : ton mot de passe Linux peut être demandé."
  sudo systemctl restart loto-croupier loto-croupier-collab 2>/dev/null || true
fi
