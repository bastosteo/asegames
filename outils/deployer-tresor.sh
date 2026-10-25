#!/usr/bin/env bash
# Installe ASE Treasure (chasse au trésor) : graine secrète des grilles, contrat, service de
# réponses Cloudflare (/api/treasure), croupier GitHub, site. Lancé par "Deployer-ASE-Treasure.bat".
# ⚠️ 2 transactions depuis "main" (déploiement + init), chacune demandée (o/n) avant.
# Peut être relancé sans risque : il ne redéploie jamais un contrat déjà en place.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
GH_AIDE="node croupier/github-aide.mjs"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
W="npx --yes wrangler@3"
SEEDF="croupier/data-tresor/seed.txt"

npm install --prefix croupier --no-audit --no-fund --silent
[ -f .loto-v3-fait ] || { echo "ERREUR : installe d'abord l'Airdrop et le nouveau loto (Deployer-ASE-Airdrop.bat)."; exit 1; }
[ -f .airdrop-fait ] || { echo "ERREUR : .airdrop-fait introuvable."; exit 1; }
[ -f croupier/data/gh-signers.json ] || { echo "ERREUR : croupier/data/gh-signers.json introuvable (Installer-croupiers-GitHub.bat)."; exit 1; }

echo "[1/6] Graine secrète des grilles (reste sur ce PC, sur GitHub et sur Cloudflare)…"
mkdir -p croupier/data-tresor
if [ ! -f "$SEEDF" ]; then node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$SEEDF"; chmod 600 "$SEEDF"; fi
SEED=$(cat "$SEEDF")
echo "      $SEEDF (à sauvegarder avec tes chaînes ; ne la donne à personne)"

LI=$($AIDE info "$(cat .loto-v3-fait)")
get() { node -e "console.log(JSON.parse(process.argv[1])['$2'])" "$1"; }
PAY_OWNER=$(get "$LI" payOwner); PAY_COLLAB=$(get "$LI" payCollab)
DROP_HEX=$($AIDE hex "$(cat .airdrop-fait)")
OPERATOR=$($AIDE hex "$($GH_AIDE signers croupier/data/gh-signers.json | awk '$1=="owner"{print $2}')")

echo "[2/6] Contrat ASE Treasure…"
if [ -f .tresor-fait ]; then NEW=$(cat .tresor-fait); echo "      Déjà en place : $NEW"
else
  NEW=""; [ -f .tresor-contrat ] && NEW=$(cat .tresor-contrat)
  if [ -z "$NEW" ]; then
    oui "      ⚠️  Déployer contrat/tresor.deploy.js ($(wc -c < contrat/tresor.deploy.js) octets) depuis main ?" || exit 1
    OUT=$(asentum deploy contrat/tresor.deploy.js --from main 2>&1) || true; echo "$OUT"
    NEW=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
    [ -n "$NEW" ] || { echo "ERREUR : adresse du contrat introuvable dans la sortie ci-dessus."; exit 1; }
    echo "$NEW" > .tresor-contrat
    echo -n "      Attente de l'inclusion… "; $AIDE attendre "$NEW" deploye
  fi
  ARGS="[\"$OPERATOR\",\"$PAY_OWNER\",\"$PAY_COLLAB\",\"$DROP_HEX\"]"
  echo "      init $ARGS"
  echo "      (opérateur = croupier GitHub ; commission 75/25 comme le loto ; moitié à l'Airdrop)"
  oui "      ⚠️  Envoyer init sur $NEW depuis main ?" || exit 1
  asentum call "$NEW" init --from main --args "$ARGS"
  echo -n "      Attente de la confirmation… "; $AIDE attendre "$NEW" initialise
  echo "$NEW" > .tresor-fait; rm -f .tresor-contrat
fi

echo "[3/6] Site…"
sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$NEW'|" tresor/js/config.js

echo "[4/6] GitHub (croupier : ouverture des grilles, preuve du trésor, remboursements)…"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  R="$(gh api user --jq .login)/asegames"
  printf %s "$SEED" | gh secret set TREASURE_SEED --repo "$R"
  gh api -X PATCH "repos/$R/actions/variables/TREASURE_CONTRACT" -f name=TREASURE_CONTRACT -f value="$NEW" >/dev/null 2>&1 \
    || gh api -X POST "repos/$R/actions/variables" -f name=TREASURE_CONTRACT -f value="$NEW" >/dev/null
  git add -A
  if git diff --cached --name-only | grep -E '(-chain\.json|gh-signers\.json|seed\.txt|(^|/)\.env($|\.)|croupier/data)' | grep -v '\.env\.exemple$'; then
    echo "ERREUR : un fichier secret allait être publié. Arrêt."; exit 1
  fi
  git commit -qm "ASE Treasure: treasure hunt on a 20x20 map" || true
  git push -q
  gh workflow run croupier.yml --repo "$R" >/dev/null 2>&1 || true
  echo "      OK : la 1re grille s'ouvre au prochain passage (10 min au plus)."
else
  echo "⚠️  GitHub non connecté : lance Installer-croupiers-GitHub.bat, puis relance ce fichier."
fi

echo "[5/6] Service de réponses sur Cloudflare (réglages secrets du site asevegas)…"
$W whoami 2>/dev/null | grep -qi "logged in" || $W login
$W pages project create asevegas --production-branch main > /dev/null 2>&1 || true
# Envoi des 2 réglages d'un coup, sans question (fichier temporaire supprimé aussitôt)
TMPJ=$(mktemp); chmod 600 "$TMPJ"
printf '{"TREASURE_SEED":"%s","TREASURE_CONTRACT":"%s"}' "$SEED" "$NEW" > "$TMPJ"
if $W pages secret bulk "$TMPJ" --project-name asevegas < /dev/null 2>&1 | grep -v "out-of-date\|wrangler@4\|npx wrangler\|latest version\|^\s*$\|WARNING"; then :; fi
rm -f "$TMPJ"
echo "      OK (réglages TREASURE_SEED et TREASURE_CONTRACT envoyés à Cloudflare)"

echo "[6/6] Mise en ligne du site (avec /api/treasure)…"
bash outils/mettre-en-ligne.sh
echo
echo "ASE Treasure : $NEW"
echo "Site : https://asevegas.pages.dev/treasure/"
