#!/usr/bin/env bash
# Met le SITE DE TEST en ligne (Cloudflare Pages, projet « asevegas-test ») avec les contrats de test
# (.test-loto, .test-raffle, .test-tresor, .test-airdrop). Ne touche pas au vrai site asevegas.com.
# Lancé par deployer-test.sh, ou par "Mettre-en-ligne-test.bat" pour une simple mise à jour.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
W="npx --yes wrangler@3"
for n in loto raffle tresor airdrop; do [ -f ".test-$n" ] || { echo "ERREUR : .test-$n introuvable (lance Installer-site-test.bat)."; exit 1; }; done
bash ./outils/assembler-asegame.sh > /dev/null
rm -rf asegame-test && cp -r asegame asegame-test
D=asegame-test
setc() { sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$2'|; s|OLD: '[^']*'|OLD: ''|" "$D/$1/js/config.js"; }
setc loto "$(cat .test-loto)"; setc raffle "$(cat .test-raffle)"; setc treasure "$(cat .test-tresor)"; setc airdrop "$(cat .test-airdrop)"
[ -f .test-hippodrome ] && bash outils/hippodrome-site-test.sh "$D"
sed -i "s|OLD_LOTO: '[^']*'|OLD_LOTO: ''|; s|OLD_RAFFLE: '[^']*'|OLD_RAFFLE: ''|; s|OLD_TREASURE: '[^']*'|OLD_TREASURE: ''|" "$D/airdrop/js/config.js"
# Bandeau « site de test » sur toutes les pages, et pas d'indexation par les moteurs de recherche
BANNER='<div style="position:sticky;top:0;z-index:9999;background:#ff2d55;color:#fff;font:700 13px/1.4 system-ui,sans-serif;text-align:center;padding:6px 10px">TEST SITE: new game versions under test, separate from asevegas.com. Testnet ASE only.</div>'
for f in $(find "$D" -name index.html); do
  sed -i "0,/<body[^>]*>/s||&$BANNER|" "$f"
  sed -i "0,/<title>/s||<title>TEST · |" "$f"
  sed -i '0,/<head>/s||<head><meta name="robots" content="noindex">|' "$f"
done
echo "[1/3] Site de test assemblé ($D)."
$W whoami 2>/dev/null | grep -qi "logged in" || $W login
$W pages project create asevegas-test --production-branch main > /dev/null 2>&1 || true
# Réglages secrets du service de réponses du Treasure de test (+ relance rapide du croupier de test)
R="$(gh api user --jq .login 2>/dev/null)/asegames"
TMPJ=$(mktemp); chmod 600 "$TMPJ"
printf '{"TREASURE_SEED":"%s","TREASURE_CONTRACT":"%s","GH_TOKEN":"%s","GH_REPO":"%s","GH_BRANCH":"main","GH_WORKFLOW":"croupier-test.yml"}' \
  "$(tr -d '\n' < croupier/data-test/tresor-seed.txt)" "$(cat .test-tresor)" "$(gh auth token 2>/dev/null || true)" "$R" > "$TMPJ"
$W pages secret bulk "$TMPJ" --project-name asevegas-test < /dev/null 2>&1 | grep -v "out-of-date\|wrangler@4\|npx wrangler\|latest version\|^\s*$\|WARNING" || true
rm -f "$TMPJ"
echo "[2/3] Réglages du service Treasure de test envoyés."
$W pages deploy "$D" --project-name asevegas-test --branch main --commit-dirty=true
echo "[3/3] En ligne : https://asevegas-test.pages.dev"
# Code des croupiers (workflow de test compris) sur GitHub
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && [ -d .git ]; then
  git add -A
  if git diff --cached --name-only | grep -E '(-chain\.json|gh-signers\.json|seed.*\.txt|(^|/)\.env($|\.)|croupier/data)' | grep -v '\.env\.exemple$'; then
    echo "ERREUR : un fichier secret allait être publié sur GitHub. Rien n'a été envoyé."; git reset -q
  else
    git commit -qm "ASE Vegas: site de test" && git push -q && echo "      GitHub à jour (croupiers de test)." || echo "      GitHub : rien de nouveau à envoyer."
  fi
fi
