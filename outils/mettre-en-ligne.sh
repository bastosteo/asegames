#!/usr/bin/env bash
# Met ASE Vegas en ligne sur Cloudflare Pages (https://asevegas.pages.dev).
# Lancé par "Mettre-en-ligne-ASE-Vegas.bat" sous Windows, ou directement dans WSL.
set -e
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
bash ./outils/assembler-asegame.sh > /dev/null
echo "[1/4] Site assemblé."
W="npx --yes wrangler@3"
if ! $W whoami 2>/dev/null | grep -qi "logged in"; then
  echo "[2/4] Connexion à Cloudflare : une page va s'ouvrir dans ton navigateur, clique sur Allow."
  echo "      (si elle ne s'ouvre pas, copie le lien affiché ci-dessous dans ton navigateur)"
  $W login
else
  echo "[2/4] Déjà connecté à Cloudflare."
fi
$W pages project create asevegas --production-branch main > /dev/null 2>&1 || true
echo "[3/4] Envoi du site sur https://asevegas.pages.dev …"
$W pages deploy asegame --project-name asevegas --branch main --commit-dirty=true
# L'ancienne adresse asegame.pages.dev renvoie maintenant vers asevegas.pages.dev (mêmes pages).
echo "[4/4] Redirection de l'ancienne adresse asegame.pages.dev…"
R=$(mktemp -d)
printf '/* https://asevegas.pages.dev/:splat 301\n' > "$R/_redirects"
printf '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=https://asevegas.pages.dev/"><title>ASE Vegas</title><a href="https://asevegas.pages.dev/">ASE Vegas has moved to asevegas.pages.dev</a>\n' > "$R/index.html"
$W pages deploy "$R" --project-name asegame --branch main --commit-dirty=true > /dev/null 2>&1 \
  && echo "      asegame.pages.dev → asevegas.pages.dev" || echo "      (redirection non faite : pas grave, l'ancien site reste tel quel)"
rm -rf "$R"
