#!/usr/bin/env bash
# Met ASE Game en ligne sur Cloudflare Pages (https://asegame.pages.dev).
# Lancé par "Mettre-en-ligne-ASE-Game.bat" sous Windows, ou directement dans WSL.
set -e
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
bash ./outils/assembler-asegame.sh > /dev/null
echo "[1/3] Site assemblé."
W="npx --yes wrangler@3"
if ! $W whoami 2>/dev/null | grep -qi "logged in"; then
  echo "[2/3] Connexion à Cloudflare : une page va s'ouvrir dans ton navigateur, clique sur Allow."
  echo "      (si elle ne s'ouvre pas, copie le lien affiché ci-dessous dans ton navigateur)"
  $W login
else
  echo "[2/3] Déjà connecté à Cloudflare."
fi
$W pages project create asegame --production-branch main > /dev/null 2>&1 || true
echo "[3/3] Envoi du site…"
$W pages deploy asegame --project-name asegame --branch main --commit-dirty=true
