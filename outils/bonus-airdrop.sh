#!/usr/bin/env bash
# Ajoute un bonus (par défaut 50 ASE) à la cagnotte de l'ASE Airdrop, depuis "main".
# Lancé par "Bonus-Airdrop.bat". Appelle fund() sur le contrat Airdrop : l'ASE envoyé
# s'ajoute à la cagnotte de la semaine (affichée sur le site), puis est partagé 50/30/20.
# ⚠️ La transaction est demandée (o/n) avant.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AMT="${1:-50}"
[ -f .airdrop-fait ] || { echo "ERREUR : .airdrop-fait introuvable."; exit 1; }
DROP=$(cat .airdrop-fait)
# Option de la CLI pour joindre de l'ASE à un appel (--value ou --amount selon la version)
H=$(asentum call --help 2>&1 || true)
if printf '%s' "$H" | grep -q -- '--value'; then OPT=--value
elif printf '%s' "$H" | grep -q -- '--amount'; then OPT=--amount
else echo "ERREUR : la CLI asentum ne dit pas comment joindre de l'ASE à un appel. Copie ce texte à Claude :"; echo "$H"; exit 1; fi
echo "Contrat Airdrop : $DROP"
read -r -p "⚠️  Envoyer $AMT ASE depuis main dans la cagnotte de l'Airdrop (fund) ? (o/n) " r
[[ "$r" =~ ^[oOyY] ]] || { echo "Rien n'a été envoyé."; exit 0; }
asentum call "$DROP" fund --from main --args '[]' $OPT "$AMT"
echo "Envoyé. La cagnotte affichée sur asevegas.com/airdrop/ se met à jour dans une minute environ."
