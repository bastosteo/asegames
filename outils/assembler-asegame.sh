#!/usr/bin/env bash
# Assemble le site complet ASE Game dans le dossier "asegame" :
#   asegame/            page d'accueil (liste des jeux)
#   asegame/loto/       ASE Loto
#   asegame/slot/       ASE Slot (bientôt)
# C'est ce dossier qu'on envoie sur Cloudflare Pages.
set -e
cd "$(dirname "$0")/.."
rm -rf asegame && mkdir -p asegame/loto
cp -r accueil/. asegame/
cp -r site/. asegame/loto/
rm -f asegame/loto/js/lotomath.test.mjs
echo "Dossier prêt : $(pwd)/asegame"
find asegame -type f | sort
