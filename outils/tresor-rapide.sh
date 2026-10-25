#!/usr/bin/env bash
# Trésor « carte suivante rapide » (aucune transaction sur la chaîne, aucun nouveau contrat) :
#  1. le site bloque les fouilles dès que le trésor a été trouvé (plus personne ne creuse pour rien) ;
#  2. le service /api/treasure lance tout de suite le croupier GitHub quand le trésor est fouillé :
#     preuve envoyée + carte suivante ouverte en 1 à 2 minutes.
# Lancé par "Tresor-rapide.bat".
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
W="npx --yes wrangler@3"
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || { echo "ERREUR : GitHub non connecté (lance Installer-croupiers-GitHub.bat)."; exit 1; }
R="$(gh api user --jq .login)/asegames"
B=$(gh api "repos/$R" --jq .default_branch)
echo "[1/3] Dépôt des croupiers : $R (branche $B)"
echo "[2/3] Réglages secrets du site sur Cloudflare (jeton GitHub pour lancer le croupier)…"
$W whoami 2>/dev/null | grep -qi "logged in" || $W login
TMPJ=$(mktemp); chmod 600 "$TMPJ"
printf '{"GH_TOKEN":"%s","GH_REPO":"%s","GH_BRANCH":"%s"}' "$(gh auth token)" "$R" "$B" > "$TMPJ"
$W pages secret bulk "$TMPJ" --project-name asevegas < /dev/null 2>&1 | grep -v "out-of-date\|wrangler@4\|npx wrangler\|latest version\|^\s*$\|WARNING" || true
rm -f "$TMPJ"
echo "      OK"
echo "[3/3] Mise en ligne du site…"
bash outils/mettre-en-ligne.sh
echo
echo "Terminé : dès que le trésor est trouvé, les fouilles sont bloquées et la carte suivante"
echo "s'ouvre en 1 à 2 minutes (le temps que GitHub lance le croupier)."
