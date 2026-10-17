#!/usr/bin/env bash
# Avant de passer au Loto à 14 numéros : récupère le jackpot actuel dans ton wallet de commission,
# grâce à la règle de prélèvement maison (setSkim). Lancé par "Recuperer-jackpot.bat".
# Règle posée : « au-dessus de J de report, J vont à la maison » (J = jackpot actuel).
# Au tirage de ce soir, si au moins 1 grille est vendue et que personne n'a 5 bons, le report dépasse
# forcément J : le contrat t'envoie J ASE. Le site affiche la nouvelle règle (House share) entre-temps.
# Demain : lance "Loto-propre.bat" et remets ce montant dans le jackpot du nouveau Loto.
# ⚠️ La transaction (depuis "main") est demandée (o/n) avant.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
get() { node -e "const v=JSON.parse(process.argv[1]);console.log(v==null?'':v['$2'])" "$1"; }
ase() { node -e "const s=BigInt(process.argv[1]).toString().padStart(19,'0');console.log((s.slice(0,-18)+'.'+s.slice(-18)).replace(/\.?0+$/,''))" "$1"; }
L=$(cat .loto-v4-fait)
C=$($AIDE cfg "$L"); I=$($AIDE info "$L")
[ -n "$(get "$C" skimAt)" ] || { echo "ERREUR : ce Loto n'a pas la règle de prélèvement."; exit 1; }
J=$(get "$I" jackpot)
echo "Loto actuel : $L"
echo "Jackpot actuel : $(ase "$J") ASE   (règle actuelle : au-dessus de $(ase "$(get "$C" skimAt)"), $(ase "$(get "$C" skimAmt)") ASE)"
[ "$J" = "0" ] && { echo "Jackpot vide : rien à récupérer."; exit 0; }
if [ "$(get "$C" skimAt)" = "$J" ] && [ "$(get "$C" skimAmt)" = "$J" ]; then echo "Règle déjà posée : $(ase "$J") ASE seront récupérés au tirage de ce soir."
else
  echo "Nouvelle règle : au-dessus de $(ase "$J") ASE de report, $(ase "$J") ASE vont dans ton wallet de commission."
  echo "(au tirage de ce soir, s'il y a au moins 1 grille vendue et personne à 5 bons)"
  read -r -p "⚠️  Envoyer setSkim [\"$J\",\"$J\"] sur le Loto depuis main ? (o/n) " r
  [[ "$r" =~ ^[oOyY] ]] || { echo "Rien n'a été envoyé."; exit 0; }
  asentum call "$L" setSkim --from main --args "[\"$J\",\"$J\"]"
  echo -n "Attente de la confirmation…"
  for i in $(seq 1 36); do sleep 5; [ "$(get "$($AIDE cfg "$L")" skimAmt)" = "$J" ] && { echo " ok"; break; }; echo -n "."; done
fi

# Il faut au moins 1 grille dans le tirage de ce soir (sinon il est sauté, sans prélèvement).
I=$($AIDE info "$L")
if [ "$(get "$I" grillesTourEnCours)" = "0" ]; then
  echo
  echo "Aucune grille n'est encore achetée pour le tirage de ce soir : sans grille, pas de tirage, donc pas de récupération."
  echo "On achète 1 grille (1 ASE) depuis main. Si le Loto est en pause, il est rouvert le temps de l'achat puis remis en pause."
  H=$(asentum call --help 2>&1 || true)
  if printf '%s' "$H" | grep -q -- '--value'; then OPT=--value; elif printf '%s' "$H" | grep -q -- '--amount'; then OPT=--amount
  else echo "La CLI ne dit pas comment joindre de l'ASE à un appel : achète 1 grille toi-même sur le site (copie ce texte à Claude si besoin)."; echo "$H"; exit 0; fi
  PZ=$(get "$($AIDE cfg "$L")" paused)
  if [ "$PZ" = "true" ]; then
    read -r -p "⚠️  Envoyer setPaused [false] (réouverture le temps d'acheter 1 grille) depuis main ? (o/n) " r
    [[ "$r" =~ ^[oOyY] ]] || { echo "Arrêt : achète 1 grille toi-même après avoir rouvert le jeu."; exit 0; }
    asentum call "$L" setPaused --from main --args '[false]'
    for i in $(seq 1 36); do sleep 5; [ "$(get "$($AIDE cfg "$L")" paused)" = "false" ] && break; done
  fi
  P=$(get "$($AIDE cfg "$L")" price); PA=$(ase "$P")
  read -r -p "⚠️  Acheter 1 grille [1,2,3,4,5] pour $PA ASE depuis main ? (o/n) " r
  if [[ "$r" =~ ^[oOyY] ]]; then
    asentum call "$L" buy --from main --args '[[[1,2,3,4,5]],""]' $OPT "$PA"
    echo -n "Attente de la confirmation…"
    for i in $(seq 1 36); do sleep 5; [ "$(get "$($AIDE info "$L")" grillesTourEnCours)" != "0" ] && { echo " ok"; break; }; echo -n "."; done
  fi
  if [ "$PZ" = "true" ]; then
    read -r -p "⚠️  Remettre le Loto en pause (setPaused [true]) depuis main ? (o/n) " r
    [[ "$r" =~ ^[oOyY] ]] && asentum call "$L" setPaused --from main --args '[true]'
  fi
fi
echo
echo "C'est réglé. Ce soir à l'heure du tirage, le jackpot part dans ton wallet de commission (la pause n'empêche pas le tirage)."
echo "Après le tirage, lance \"Loto-propre.bat\" (ou demain matin)."
