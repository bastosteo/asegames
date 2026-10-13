#!/usr/bin/env bash
# Ventes du Loto et de la Raffle fermées 1 h avant le tirage (20h00 Paris au lieu de 20h50) :
# le tirage se fait avant 21h00 Paris, et le site dévoile les résultats et les gains à 21h00 pile.
# Airdrop : la semaine se ferme le lundi à 20h00 Paris, les prix partent à 21h00 Paris.
# Lancé par "Fermeture-1h-avant.bat".
#  1. met le site à jour (résultats cachés jusqu'à l'heure du tirage) ;
#  2. 3 transactions depuis "main" (Loto, Raffle, Airdrop), chacune demandée (o/n) avant.
# Le réglage s'applique au tirage suivant si des tickets sont déjà vendus pour celui en cours.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
# Attend (3 min max) que le contrat affiche la fermeture à 60 min
attendre() { echo -n "      Attente de la confirmation…"; for i in $(seq 1 36); do sleep 5; [ "$(get "$($AIDE cfg "$1")" "${2:-closeMin}")" = "${3:-60}" ] && { echo " ok"; return 0; }; echo -n "."; done; echo " pas encore visible (vérifie plus tard)"; }
get() { node -e "console.log(JSON.parse(process.argv[1])['$2'])" "$1"; }
LOTO=""; RAFFLE=""
[ -f .loto-v4-fait ] && LOTO=$(cat .loto-v4-fait)
[ -f .tombola-v3-fait ] && RAFFLE=$(cat .tombola-v3-fait)
[ -n "$LOTO" ] && [ -n "$RAFFLE" ] || { echo "ERREUR : contrats v4 introuvables (.loto-v4-fait / .tombola-v3-fait)."; exit 1; }

echo "[1/4] Mise en ligne du site (résultats dévoilés à 19:00 UTC)…"
bash outils/mettre-en-ligne.sh

echo "[2/4] Loto ($LOTO)…"
C=$($AIDE cfg "$LOTO")
if [ "$(get "$C" closeMin)" = "60" ]; then echo "      Déjà fermé 1 h avant."
else
  A="[\"$(get "$C" price)\",$(get "$C" drawH),$(get "$C" drawM),$(get "$C" maxGrids),60,$(get "$C" revealMin),$(get "$C" maxRound)]"
  echo "      setConfig $A   (seul changement : fermeture 10 → 60 min avant)"
  if oui "      ⚠️  Envoyer setConfig sur le Loto depuis main ?"; then
    asentum call "$LOTO" setConfig --from main --args "$A"
    attendre "$LOTO"
  fi
fi

echo "[3/4] Raffle ($RAFFLE)…"
C=$($AIDE cfg "$RAFFLE")
if [ "$(get "$C" closeMin)" = "60" ]; then echo "      Déjà fermée 1 h avant."
else
  A="[\"$(get "$C" price)\",$(get "$C" drawDay),$(get "$C" drawH),$(get "$C" drawM),$(get "$C" maxPerWallet),60,$(get "$C" revealMin),$(get "$C" maxRound)]"
  echo "      setConfig $A   (seul changement : fermeture 10 → 60 min avant)"
  if oui "      ⚠️  Envoyer setConfig sur la Raffle depuis main ?"; then
    asentum call "$RAFFLE" setConfig --from main --args "$A"
    attendre "$RAFFLE"
  fi
fi

echo "[4/4] Airdrop…"
if [ -f .airdrop-fait ]; then
  DROP=$(cat .airdrop-fait); C=$($AIDE cfg "$DROP")
  if [ "$(get "$C" drawH)" = "20" ]; then echo "      Déjà réglé (lundi 20h00 Paris, prix envoyés à 21h00)."
  else
    A="[1,20,0,420]"
    echo "      setConfig $A   (lundi 20h00 Paris : fin de la semaine ; les prix partent à 21h00 ; délai max 7 h)"
    if oui "      ⚠️  Envoyer setConfig sur l'Airdrop depuis main ?"; then
      asentum call "$DROP" setConfig --from main --args "$A"
      attendre "$DROP" drawH 20
    fi
  fi
fi
echo
echo "Terminé : ventes fermées 1 h avant, résultats et prix de l'Airdrop à 21h00 (heure de Paris)."
