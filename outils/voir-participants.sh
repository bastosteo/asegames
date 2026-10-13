#!/usr/bin/env bash
# Lecture seule : qui a joué le tirage du Loto, la Raffle et la carte Treasure EN COURS,
# et combien lui rembourser. Lancé par "Voir-participants.bat". Aucune transaction.
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
L=$(cat .v5-ancien-loto 2>/dev/null || cat .loto-v4-fait)
R=$(cat .v5-ancien-raffle 2>/dev/null || cat .tombola-v3-fait)
T=$(cat .v5-ancien-tresor 2>/dev/null || cat .tresor-v2-fait)
echo "Loto     : $L"; echo "Raffle   : $R"; echo "Treasure : $T"; echo
node outils/rembourser.mjs liste "$L" "$R" "$T" 2>/dev/null | awk -F'\t' '
  { printf "%s  %s ASE  (%s)\n", $1, $2, $3; t += $2; n++ }
  END { if (n) printf "\nTotal : %s ASE pour %d wallet(s)\n", t, n; else print "Personne n a joue le tirage, la Raffle ni la carte en cours." }'
