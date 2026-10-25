#!/usr/bin/env bash
# Nouvelle tombola (v4) : tirages dimanche, mardi et jeudi à 21 h (Paris), 5 ASE le ticket,
# top 3 (50/30/20 % de la cagnotte) + jusqu'à 27 lots de 100 ASE. Lancé par "Nouvelle-Raffle.bat".
# À lancer DIMANCHE SOIR, juste APRÈS le tirage de la tombola actuelle (21 h).
# Étapes (chaque transaction depuis "main" est demandée o/n avant ; relançable sans risque) :
#  1. vérifie que le tirage de dimanche est fait, puis met l'ancienne tombola en pause ;
#  2. déploie, initialise et règle la nouvelle tombola (mêmes wallets, mêmes chaînes de secrets) ;
#  3. site, GitHub et croupiers passent sur la nouvelle tombola ;
#  4. rembourse ceux qui auraient acheté un ticket de l'ancienne entre le tirage et la pause.
# Les prix déjà gagnés sur l'ancienne tombola restent réclamables (« My wins »).
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
RB="node outils/rembourser.mjs"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
get() { node -e "const v=JSON.parse(process.argv[1]);console.log(v==null||v['$2']==null?'':v['$2'])" "$1"; }
ase() { node -e "const s=BigInt(process.argv[1]).toString().padStart(19,'0');console.log((s.slice(0,-18)+'.'+s.slice(-18)).replace(/\.?0+$/,''))" "$1"; }
when() { node -e "console.log(new Date(Number(process.argv[1])).toLocaleString('fr-FR',{timeZone:'Europe/Paris',weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}))" "$1"; }

npm install --prefix croupier --no-audit --no-fund --silent
for f in .tombola-v3-fait .airdrop-fait; do [ -f "$f" ] || { echo "ERREUR : fichier $f introuvable."; exit 1; }; done
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || { echo "ERREUR : GitHub non connecté (lance Installer-croupiers-GitHub.bat)."; exit 1; }
grep -q drawDays contrat/tombola.deploy.js || { echo "ERREUR : contrat/tombola.deploy.js n'est pas la tombola v4 (ancien zip ?). Rien n'a été envoyé."; exit 1; }
R="$(gh api user --jq .login)/asegames"
[ -f .v7-ancienne-raffle ] || cp .tombola-v3-fait .v7-ancienne-raffle
OR=$(cat .v7-ancienne-raffle)
echo "Tombola actuelle : $OR"
if [ -n "$(get "$($AIDE cfg "$(cat .tombola-v3-fait)")" drawDays)" ]; then echo "La tombola en service est déjà la v4 : rien à faire."; exit 0; fi

echo "[1/4] Vérification puis pause de l'ancienne tombola…"
OC=$($AIDE cfg "$OR"); T=$($AIDE tombola "$OR")
if [ "$(get "$OC" paused)" != "true" ]; then
  V=$($RB verifier - "$OR" -)
  if [ "$V" != "OK" ]; then echo "      ⏳ ${V#ATTENTE	}. Rien n'a été envoyé : relance ce fichier après le tirage."; exit 3; fi
  NOW=$(get "$T" now); LAST=$(get "$T" lastDone)   # heure de la chaîne
  if [ "$(get "$T" tickets)" != "0" ] && [ $(( NOW - LAST )) -gt $(( 6 * 3600 * 1000 )) ]; then
    echo "      ⏳ La tombola en cours a déjà $(get "$T" tickets) tickets et son tirage est $(when "$(get "$T" drawTs)")."
    echo "      Lance ce fichier dimanche soir JUSTE APRÈS le tirage (sinon il faudrait rembourser toute la tombola). Rien n'a été envoyé."
    exit 3
  fi
  oui "      ⚠️  Envoyer setPaused [true] sur l'ancienne tombola depuis main ?" || { echo "      Arrêt demandé : rien n'a été envoyé."; exit 1; }
  asentum call "$OR" setPaused --from main --args '[true]'
  echo -n "      Attente de la confirmation… "; $AIDE attendre "$OR" pause
else echo "      Déjà en pause."; fi
$RB liste - "$OR" - > remboursements-raffle-v4.txt
if [ -s remboursements-raffle-v4.txt ]; then echo "      Tickets à rembourser à la fin :"; awk -F'\t' '{ printf "        %s  %s ASE  (%s)\n", $1, $2, $3 }' remboursements-raffle-v4.txt
else echo "      Personne à rembourser."; fi

echo "[2/4] Nouvelle tombola…"
OC=$($AIDE cfg "$OR"); OI=$($AIDE info "$OR")
N=""; [ -f .v7-raffle ] && N=$(cat .v7-raffle)
[ -z "$N" ] && [ -f .v7-raffle-contrat ] && N=$(cat .v7-raffle-contrat)
if [ -z "$N" ]; then
  oui "      ⚠️  Déployer la nouvelle tombola (contrat/tombola.deploy.js, $(wc -c < contrat/tombola.deploy.js) octets) depuis main ?" || exit 1
  OUT=$(asentum deploy contrat/tombola.deploy.js --from main 2>&1) || true; echo "$OUT"
  N=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
  [ -n "$N" ] || { echo "ERREUR : adresse du contrat introuvable dans la sortie ci-dessus."; exit 1; }
  echo "$N" > .v7-raffle-contrat
  echo -n "      Attente de l'inclusion… "; $AIDE attendre "$N" deploye
else echo "      Déjà déployée : $N"; fi
if [ -z "$(get "$($AIDE cfg "$N")" admin)" ]; then
  A="[\"$(get "$OC" payOwner)\",\"$(get "$OC" payCollab)\",\"$(get "$OC" collabAdmin)\",\"$(get "$OI" tipO)\",\"$(get "$OI" tipC)\",\"$(get "$OC" payAirdrop)\"]"
  echo "      init $A"
  oui "      ⚠️  Envoyer init sur $N depuis main ?" || exit 1
  asentum call "$N" init --from main --args "$A"
  echo -n "      Attente de la confirmation… "; $AIDE attendre "$N" initialise
else echo "      Déjà initialisée."; fi
echo "$N" > .v7-raffle; rm -f .v7-raffle-contrat
C=$($AIDE cfg "$N")
if [ "$(get "$C" closeMin)" = "$(get "$OC" closeMin)" ] && [ "$(get "$C" price)" = "$(get "$OC" price)" ]; then echo "      Déjà réglée (même prix et mêmes horaires que l'ancienne)."
else
  A="[\"$(get "$OC" price)\",21,$(get "$OC" drawH),$(get "$OC" drawM),10,$(get "$OC" closeMin),$(get "$OC" revealMin),$(get "$OC" maxRound)]"
  echo "      setConfig $A   ($(ase "$(get "$OC" price)") ASE le ticket, dimanche + mardi + jeudi, 10 tickets max par wallet et par tirage)"
  oui "      ⚠️  Envoyer setConfig sur la nouvelle tombola depuis main ?" || exit 1
  asentum call "$N" setConfig --from main --args "$A"
  echo -n "      Attente de la confirmation…"
  for i in $(seq 1 36); do sleep 5; [ "$(get "$($AIDE cfg "$N")" closeMin)" = "$(get "$OC" closeMin)" ] && { echo " ok"; break; }; echo -n "."; done
fi
T=$($AIDE tombola "$N")
echo "      Nouvelle tombola : 1er tirage $(when "$(get "$T" drawTs)"), top 3 + jusqu'à 27 lots de 100 ASE."

echo "[3/4] Site, GitHub et croupiers passent sur la nouvelle tombola…"
echo "$N" > .tombola-v3-fait          # tombola en cours (lue par le site et les autres scripts)
PA=$(cat .raffle-ancienne 2>/dev/null || true)
case ",$PA," in *",$OR,"*) ;; *) echo "$OR${PA:+,$PA}" > .raffle-ancienne;; esac   # prix déjà gagnés toujours réclamables
PREV=$(cat .old-raffle 2>/dev/null || true)
case ",$PREV," in *",$OR,"*) ;; *) echo "$OR${PREV:+,$PREV}" > .old-raffle;; esac   # tickets de la semaine comptés par l'Airdrop
sed -i "s/$OR/$N/g" .github/workflows/croupier.yml
setvar() { gh api -X PATCH "repos/$R/actions/variables/$1" -f name="$1" -f value="$2" >/dev/null 2>&1 || gh api -X POST "repos/$R/actions/variables" -f name="$1" -f value="$2" >/dev/null; }
setvar RAFFLE_CONTRACT "$N"; setvar OLD_RAFFLE "$(cat .old-raffle)"
echo "      GitHub : RAFFLE_CONTRACT = $N"
bash outils/mettre-en-ligne.sh
gh workflow run croupier.yml --repo "$R" >/dev/null 2>&1 || true

echo "[4/4] Remboursements (tickets achetés sur l'ancienne tombola après le tirage)…"
$RB liste - "$OR" - > remboursements-raffle-v4.txt
touch remboursements-faits.txt
if [ -s remboursements-raffle-v4.txt ]; then
  while IFS=$'\t' read -r ADDR AMT DETAIL <&3; do
    if grep -qx "raffle4:$ADDR" remboursements-faits.txt; then echo "      $ADDR : déjà remboursé."; continue; fi
    echo "      $ADDR ← $AMT ASE  ($DETAIL)"
    if oui "      ⚠️  Envoyer $AMT ASE depuis main à $ADDR ?"; then
      asentum send --from main --to "$ADDR" --amount "$AMT"
      echo "raffle4:$ADDR" >> remboursements-faits.txt; sleep 3
    else echo "      Pas envoyé (relance ce fichier pour le proposer à nouveau)."; fi
  done 3< remboursements-raffle-v4.txt
else echo "      Personne à rembourser."; fi
echo
echo "Nouvelle tombola : $N"
echo "⚠️  Envoie cette adresse à Asentum (ticket support) pour que les quêtes « Raffle » pointent dessus."
echo "Site : https://asevegas.com/raffle/"
