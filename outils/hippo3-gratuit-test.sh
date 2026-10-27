#!/usr/bin/env bash
# Hippodrome v3 (site de test) : chevaux gratuits. Lancé par "Hippodrome-v3-gratuit.bat".
#  Met à 0 sur l'ÉCURIE : prix des 6 classes de chevaux, nourrir, entraîner, inscription.
#  (La caution des croupiers et les mises des Paris ne changent pas.)
# ⚠️ Chaque transaction (depuis "main", l'admin) est demandée (o/n) avant.
# Peut être relancé sans risque : il ne refait jamais un réglage déjà à 0.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
HA="node outils/hippo-aide.mjs"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }

[ -f .test-hippo3-ecurie ] || { echo "ERREUR : .test-hippo3-ecurie introuvable (adresse de l'Écurie de test)."; exit 1; }
NE=$(cat .test-hippo3-ecurie)
# valeur actuelle d'un réglage (les prix : les 6 séparés par des virgules)
val() { $HA cfg "$NE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);const v=c['$1'];console.log(Array.isArray(v)?v.join(','):v)})"; }
ase() { node -e "console.log(Number(BigInt(process.argv[1])/10n**15n)/1000)" "$1"; }
attendre() { # $1 réglage, $2 valeur attendue
  for _ in $(seq 1 60); do [ "$(val "$1" 2>/dev/null)" = "$2" ] && { echo "OK"; return 0; }; echo -n "."; sleep 10; done
  echo; echo "ERREUR : pas de confirmation après 10 minutes (regarde l'explorateur, puis relance)."; exit 1
}

echo "Écurie de test : $NE"
[ -n "$($HA cfg "$NE")" ] || { echo "ERREUR : impossible de lire les réglages de l'Écurie."; exit 1; }

echo "[1/4] Prix des chevaux (6 classes)…"
P=$(val prices)
if [ "$P" = "0,0,0,0,0,0" ]; then echo "      Déjà gratuits."
else
  echo "      Prix actuels : $(for x in ${P//,/ }; do echo -n "$(ase "$x") "; done)ASE"
  oui "      ⚠️  Mettre les 6 prix à 0 ASE (set prices) depuis main ?" || exit 1
  asentum call "$NE" set --from main --args '["prices","[\"0\",\"0\",\"0\",\"0\",\"0\",\"0\"]"]'
  echo -n "      Attente de la confirmation… "; attendre prices "0,0,0,0,0,0"
fi

N=2
for K in feed train entry; do
  case $K in feed) L="Nourrir";; train) L="Entraîner";; entry) L="Inscription à la course";; esac
  echo "[$N/4] $L…"; N=$((N+1))
  V=$(val $K)
  if [ "$V" = "0" ]; then echo "      Déjà gratuit."
  else
    oui "      ⚠️  $L : passer de $(ase "$V") ASE à 0 ASE (set $K) depuis main ?" || exit 1
    asentum call "$NE" set --from main --args "[\"$K\",\"0\"]"
    echo -n "      Attente de la confirmation… "; attendre $K 0
  fi
done

echo
echo "Écurie de test : chevaux, nourriture, entraînement et inscription gratuits."
