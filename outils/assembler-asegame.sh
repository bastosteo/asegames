#!/usr/bin/env bash
# Assemble le site complet ASE Vegas dans le dossier "asegame" :
#   asegame/            page d'accueil (liste des jeux)
#   asegame/loto/       ASE Loto
#   asegame/raffle/     ASE Raffle (tombola hebdomadaire)
#   asegame/airdrop/    ASE Airdrop (tirage hebdomadaire des frais)
#   asegame/treasure/   ASE Treasure (chasse au trésor) + functions/ (service de réponses)
# C'est ce dossier qu'on envoie sur Cloudflare Pages.
set -e
cd "$(dirname "$0")/.."
rm -rf asegame && mkdir -p asegame/loto
cp -r accueil/. asegame/
cp -r site/. asegame/loto/
mkdir -p asegame/raffle && cp -r tombola/. asegame/raffle/
mkdir -p asegame/airdrop && cp -r airdrop/. asegame/airdrop/
mkdir -p asegame/treasure && cp -r tresor/. asegame/treasure/ && cp functions/_lib/board.mjs asegame/treasure/js/board.mjs && cp contrat/tresor.js asegame/treasure/contrat/tresor.js
rm -rf asegame/slot
rm -f asegame/loto/js/lotomath.test.mjs
# Adresses des contrats déjà déployés (gardées sur ce PC, le zip ne les contient pas toujours)
[ -f .loto-v2-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .loto-v2-fait)'|" asegame/loto/js/config.js
[ -f .tombola-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .tombola-fait)'|" asegame/raffle/js/config.js
[ -f .loto-v3-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .loto-v3-fait)'|" asegame/loto/js/config.js
[ -f .tombola-v2-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .tombola-v2-fait)'|" asegame/raffle/js/config.js
[ -f .tresor-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .tresor-fait)'|" asegame/treasure/js/config.js
[ -f .airdrop-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .airdrop-fait)'|" asegame/airdrop/js/config.js
# Version « sans remboursement » (loto v4, tombola v3, trésor v2)
[ -f .loto-v4-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .loto-v4-fait)'|" asegame/loto/js/config.js
[ -f .tombola-v3-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .tombola-v3-fait)'|" asegame/raffle/js/config.js
[ -f .tresor-v2-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .tresor-v2-fait)'|" asegame/treasure/js/config.js
# Trésor v3 (liste de wallets bannis)
[ -f .tresor-v3-fait ] && sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$(cat .tresor-v3-fait)'|" asegame/treasure/js/config.js
[ -f .loto-ancien ] && sed -i "s|OLD: '[^']*'|OLD: '$(cat .loto-ancien)'|" asegame/loto/js/config.js
[ -f .raffle-ancienne ] && sed -i "s|OLD: '[^']*'|OLD: '$(cat .raffle-ancienne)'|" asegame/raffle/js/config.js
[ -f .old-loto ] && sed -i "s|OLD_LOTO: '[^']*'|OLD_LOTO: '$(cat .old-loto)'|" asegame/airdrop/js/config.js
[ -f .old-raffle ] && sed -i "s|OLD_RAFFLE: '[^']*'|OLD_RAFFLE: '$(cat .old-raffle)'|" asegame/airdrop/js/config.js
[ -f .old-tresor ] && sed -i "s|OLD_TREASURE: '[^']*'|OLD_TREASURE: '$(cat .old-tresor)'|" asegame/airdrop/js/config.js
echo "Dossier prêt : $(pwd)/asegame"
find asegame -type f | sort
