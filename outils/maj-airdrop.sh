#!/usr/bin/env bash
# Page ASE Airdrop : affichage plus rapide (lectures en parallèle, réessais si le testnet sature,
# mémoire des grilles/tirages terminés, montant provisoire tout de suite). Aucune transaction.
# Lancé par "Airdrop-affichage.bat".
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
M=outils/maj-airdrop
pareil() { cmp -s <(tr -d '\r' < "$1") <(tr -d '\r' < "$2"); }
DIFF=0
for f in airdrop.js liste.mjs; do
  if pareil "airdrop/js/$f" "$M/$f"; then echo "      $f : déjà à jour"
  elif pareil "airdrop/js/$f" "$M/avant/$f"; then echo "      $f : version en ligne, ok"
  else
    DIFF=1; echo "      $f : différent de la version en ligne sur asevegas.com. Différences :"
    diff <(tr -d '\r' < "$M/avant/$f") <(tr -d '\r' < "airdrop/js/$f") | head -20 || true
  fi
done
if [ "$DIFF" = 1 ]; then
  echo "      (lignes « < » = version en ligne, « > » = ta version sur le PC)"
  oui "      Remplacer quand même ? (une copie de ta version est gardée dans outils/maj-airdrop/sauvegarde)" || { echo "Rien n'a été modifié. Envoie ce texte à Claude."; exit 1; }
fi
mkdir -p "$M/sauvegarde" && cp airdrop/js/airdrop.js airdrop/js/liste.mjs "$M/sauvegarde/"
cp "$M/airdrop.js" airdrop/js/airdrop.js
cp "$M/liste.mjs" airdrop/js/liste.mjs
echo "Page Airdrop mise à jour. Mise en ligne de asevegas.com…"
bash outils/mettre-en-ligne.sh
