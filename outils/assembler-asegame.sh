#!/usr/bin/env bash
# Assemble le site complet ASE Game dans le dossier "asegame" :
#   asegame/            page d'accueil (liste des jeux)
#   asegame/loto/       ASE Loto
#   asegame/raffle/     ASE Raffle (tombola hebdomadaire)
#   asegame/airdrop/    ASE Airdrop (tirage hebdomadaire des frais)
#   asegame/slot/       ASE Slot (bientôt)
# C'est ce dossier qu'on envoie sur Cloudflare Pages.
set -e
cd "$(dirname "$0")/.."
rm -rf asegame && mkdir -p asegame/loto
cp -r accueil/. asegame/
cp -r site/. asegame/loto/
mkdir -p asegame/raffle && cp -r tombola/. asegame/raffle/
mkdir -p asegame/airdrop && cp -r airdrop/. asegame/airdrop/
rm -f asegame/loto/js/lotomath.test.mjs
# Adresses des contrats déjà déployés (gardées sur ce PC, le zip ne les contient pas toujours)
[ -f .loto-v2-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .loto-v2-fait)'|" asegame/loto/js/config.js
[ -f .tombola-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .tombola-fait)'|" asegame/raffle/js/config.js
[ -f .loto-v3-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .loto-v3-fait)'|" asegame/loto/js/config.js
[ -f .tombola-v2-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .tombola-v2-fait)'|" asegame/raffle/js/config.js
[ -f .airdrop-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .airdrop-fait)'|" asegame/airdrop/js/config.js
echo "Dossier prêt : $(pwd)/asegame"
find asegame -type f | sort
