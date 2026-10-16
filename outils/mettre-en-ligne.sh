#!/usr/bin/env bash
# Met ASE Vegas en ligne sur Cloudflare Pages (https://asevegas.com, et asevegas.pages.dev).
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
echo "[3/4] Envoi du site sur https://asevegas.com …"
$W pages deploy asegame --project-name asevegas --branch main --commit-dirty=true
# L'ancienne adresse asegame.pages.dev renvoie maintenant vers asevegas.pages.dev (mêmes pages).
echo "[4/4] Redirection de l'ancienne adresse asegame.pages.dev…"
R=$(mktemp -d)
printf '/* https://asevegas.com/:splat 301\n' > "$R/_redirects"
printf '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=https://asevegas.com/"><title>ASE Vegas</title><a href="https://asevegas.com/">ASE Vegas has moved to asevegas.com</a>\n' > "$R/index.html"
(cd "$R" && $W pages deploy . --project-name asegame --branch main --commit-dirty=true > /dev/null 2>&1) \
  && echo "      asegame.pages.dev → asevegas.com" || echo "      (redirection non faite : pas grave, l'ancien site reste tel quel)"
rm -rf "$R"
# Croupiers GitHub : envoie aussi le code à jour (croupier, règles) sur le dépôt asegames
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && [ -d .git ]; then
  git add -A
  if git diff --cached --name-only | grep -E '(-chain\.json|gh-signers\.json|seed.*\.txt|(^|/)\.env($|\.)|croupier/data)' | grep -v '\.env\.exemple$'; then
    echo "ERREUR : un fichier secret allait être publié sur GitHub. Rien n'a été envoyé."; git reset -q
  else
    git commit -qm "ASE Vegas: mise à jour" && git push -q && echo "      GitHub à jour (croupiers)." || echo "      GitHub : rien de nouveau à envoyer."
  fi
fi
