#!/usr/bin/env bash
# Installe le « réveil » des croupiers sur Cloudflare (gratuit) : un Worker qui lance le workflow
# GitHub des croupiers toutes les 10 minutes, car GitHub saute beaucoup de passages programmés.
# Lancé par "Installer-reveil-croupiers.bat". Aucune transaction sur la chaîne.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
W="npx --yes wrangler@3"
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || { echo "ERREUR : GitHub non connecté (lance Installer-croupiers-GitHub.bat)."; exit 1; }
R="$(gh api user --jq .login)/asegames"
B=$(gh api "repos/$R" --jq .default_branch)
echo "[1/4] Dépôt : $R (branche $B)"
echo "[2/4] Test : lancement d'un passage des croupiers maintenant…"
gh workflow run croupier.yml --repo "$R" --ref "$B" && echo "      OK (visible dans l'onglet Actions dans quelques secondes)."
echo "[3/4] Cloudflare…"
cd reveil
sed -i "s|^REPO = .*|REPO = \"$R\"|; s|^BRANCH = .*|BRANCH = \"$B\"|" wrangler.toml
$W whoami 2>/dev/null | grep -qi "logged in" || $W login
$W deploy 2>&1 | grep -v "out-of-date\|wrangler@4\|latest version\|WARNING" || true
gh auth token | $W secret put GH_TOKEN 2>&1 | grep -v "out-of-date\|wrangler@4\|latest version\|WARNING" || true
echo "[4/4] Terminé : Cloudflare lancera les croupiers toutes les 10 minutes."
echo "      Vérifie dans GitHub → Actions : une ligne « workflow_dispatch » toutes les 10 minutes."
