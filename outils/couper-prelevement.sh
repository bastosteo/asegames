#!/usr/bin/env bash
# Coupe la règle de prélèvement sur le jackpot (setSkim 0,0) du Loto actuel, puis met le site en ligne.
# Lancé par "Couper-prelevement.bat". ⚠️ La transaction (depuis "main") est demandée (o/n) avant.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
get() { node -e "const v=JSON.parse(process.argv[1]);console.log(v==null||v['$2']==null?'':v['$2'])" "$1"; }
ase() { node -e "const s=BigInt(process.argv[1]).toString().padStart(19,'0');console.log((s.slice(0,-18)+'.'+s.slice(-18)).replace(/\.?0+$/,''))" "$1"; }
L=$(cat .loto-v4-fait)
C=$($AIDE cfg "$L")
echo "Loto actuel : $L"
AT=$(get "$C" skimAt); AMT=$(get "$C" skimAmt)
if [ -z "$AT" ]; then echo "Ce Loto n'a pas de règle de prélèvement : rien à faire."
elif [ "$AMT" = "0" ]; then echo "Prélèvement déjà coupé."
else
  echo "Règle actuelle : au-dessus de $(ase "$AT") ASE de jackpot, $(ase "$AMT") ASE vont à la maison."
  read -r -p "⚠️  Envoyer setSkim [\"0\",\"0\"] (couper le prélèvement) sur le Loto depuis main ? (o/n) " r
  [[ "$r" =~ ^[oOyY] ]] || { echo "Annulé, rien n'a été envoyé."; exit 1; }
  asentum call "$L" setSkim --from main --args '["0","0"]'
  echo "Attente de la confirmation (jusqu'à 2 minutes)..."
  ok=0; for i in $(seq 1 24); do sleep 5; C=$($AIDE cfg "$L"); [ "$(get "$C" skimAmt)" = "0" ] && { ok=1; break; }; done
  [ $ok = 1 ] && echo "✅ Prélèvement coupé : tout le jackpot reste aux joueurs." || { echo "Pas encore confirmé. Attends 2 minutes et relance ce fichier (il ne renverra rien si c'est passé)."; exit 1; }
fi
echo
read -r -p "Mettre le site à jour (texte « admin powers ») ? (o/n) " r
[[ "$r" =~ ^[oOyY] ]] && bash outils/mettre-en-ligne.sh
exit 0
