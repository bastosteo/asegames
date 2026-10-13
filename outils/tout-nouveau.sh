#!/usr/bin/env bash
# Nouveaux prix TOUT DE SUITE sur les 3 jeux : Loto 1 ASE, Raffle 2 ASE, Treasure 0,2 ASE.
# Lancé par "Nouveaux-prix-maintenant.bat".
# Un tirage déjà commencé ne peut pas changer de prix : on remplace donc les 3 contrats
# (même code, mêmes wallets, mêmes chaînes de secrets, nouvelle graine des cartes du trésor),
# et TU rembourses toi-même, depuis "main", tous ceux qui ont joué le tirage / la Raffle /
# la carte en cours (le prix payé, en entier). L'argent des anciens contrats y reste
# (aucun contrat n'a de fonction de retrait) : jackpot du Loto et trésor en cours compris.
# Étapes :
#  1. vérifie qu'aucun tirage n'est en cours, puis met les 3 anciens contrats en pause ;
#  2. liste les remboursements (enregistrée dans remboursements.txt) ;
#  3. déploie, initialise et règle les 3 nouveaux contrats ;
#  4. site, GitHub, Cloudflare et croupiers passent sur les nouveaux contrats ;
#  5. envoie chaque remboursement depuis main.
# ⚠️ Chaque transaction (depuis "main") est demandée (o/n) avant. Relançable sans risque :
# une étape déjà faite n'est jamais refaite (fichiers .v5-*).
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
RB="node outils/rembourser.mjs"
W="npx --yes wrangler@3"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
get() { node -e "const v=JSON.parse(process.argv[1]);console.log(v==null?'':v['$2'])" "$1"; }
P_LOTO=1000000000000000000; P_RAFFLE=2000000000000000000; P_TRESOR=200000000000000000

npm install --prefix croupier --no-audit --no-fund --silent
for f in .loto-v4-fait .tombola-v3-fait .tresor-v2-fait .airdrop-fait croupier/data-tresor/seed-v2.txt; do
  [ -f "$f" ] || { echo "ERREUR : fichier $f introuvable."; exit 1; }
done
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || { echo "ERREUR : GitHub non connecté (lance Installer-croupiers-GitHub.bat)."; exit 1; }
R="$(gh api user --jq .login)/asegames"
DROP_HEX=$($AIDE hex "$(cat .airdrop-fait)")

# Anciens contrats, notés une seule fois (au 1er lancement). Si Nouveaux-prix.bat a déjà
# remplacé la Raffle, l'ancienne est celle qu'il a notée (.raffle-ancienne).
[ -f .v5-ancien-loto ] || cp .loto-v4-fait .v5-ancien-loto
[ -f .v5-ancien-tresor ] || cp .tresor-v2-fait .v5-ancien-tresor
if [ ! -f .v5-ancien-raffle ]; then
  if [ -f .raffle-2ase-fait ] && [ -f .raffle-ancienne ]; then cp .raffle-ancienne .v5-ancien-raffle; echo "deja" > .v5-raffle-deja; else cp .tombola-v3-fait .v5-ancien-raffle; fi
fi
OL=$(cat .v5-ancien-loto); OR=$(cat .v5-ancien-raffle); OT=$(cat .v5-ancien-tresor)
OLD_SEED=$(cat croupier/data-tresor/seed-v2.txt)

echo "[1/5] Anciens contrats : vérification puis pause…"
if [ ! -f .v5-pauses ]; then
  V=$(TREASURE_SEED="$OLD_SEED" $RB verifier "$OL" "$OR" "$OT")
  if [ "$V" != "OK" ]; then
    echo "      ⏳ ${V#ATTENTE	}."
    echo "      Rien n'a été envoyé. Relance ce fichier un peu plus tard (après 21h00 pour le Loto)."
    exit 3
  fi
  pause() { # $1 contrat, $2 nom
    if [ "$(get "$($AIDE cfg "$1")" paused)" = "true" ]; then echo "      $2 : déjà en pause."; return; fi
    oui "      ⚠️  Envoyer setPaused [true] sur l'ancien $2 depuis main ?" || { echo "      Arrêt demandé."; exit 1; }
    asentum call "$1" setPaused --from main --args '[true]'
    echo -n "      Attente de la confirmation… "; $AIDE attendre "$1" pause
  }
  pause "$OL" "Loto"; pause "$OR" "Raffle"; pause "$OT" "Treasure"
  touch .v5-pauses
else echo "      Déjà fait."; fi

# Liste relue sur la chaîne à chaque fois (enregistrée dans remboursements.txt)
liste() {
  $RB liste "$OL" "$OR" "$OT" > remboursements.tmp && mv remboursements.tmp remboursements.txt
  if [ -s remboursements.txt ]; then
    echo "      $(wc -l < remboursements.txt) wallet(s) à rembourser :"
    awk -F'\t' '{ printf "        %s  %s ASE  (%s)\n", $1, $2, $3; t += $2 } END { printf "      Total : %s ASE\n", t }' remboursements.txt
  else echo "      Personne à rembourser."; fi
}
echo "[2/5] Qui a joué le tirage, la Raffle et la carte en cours (à rembourser à la fin)…"
liste

# Déploie puis initialise un contrat. Résultat (adresse) dans RES.
deployer() { # $1 = nom, $2 = fichier, $3 = marqueur, $4 = arguments de init (JSON)
  local nom="$1" f="$2" m="$3" args="$4" N=""
  if [ -f ".v5-$m" ]; then RES=$(cat ".v5-$m"); echo "      $nom déjà en place : $RES"; return; fi
  [ -f ".v5-$m-contrat" ] && N=$(cat ".v5-$m-contrat")
  if [ -z "$N" ]; then
    oui "      ⚠️  Déployer $nom ($f, $(wc -c < "$f") octets) depuis main ?" || exit 1
    OUT=$(asentum deploy "$f" --from main 2>&1) || true; echo "$OUT"
    N=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
    [ -n "$N" ] || { echo "ERREUR : adresse du contrat introuvable dans la sortie ci-dessus."; exit 1; }
    echo "$N" > ".v5-$m-contrat"
    echo -n "      Attente de l'inclusion… "; $AIDE attendre "$N" deploye
  else echo "      $nom déjà déployé : $N"; fi
  if [ -n "$(get "$($AIDE cfg "$N")" admin)" ]; then echo "      Déjà initialisé."
  else
    echo "      init $args"
    oui "      ⚠️  Envoyer init sur $N depuis main ?" || exit 1
    asentum call "$N" init --from main --args "$args"
    echo -n "      Attente de la confirmation… "; $AIDE attendre "$N" initialise
  fi
  echo "$N" > ".v5-$m"; rm -f ".v5-$m-contrat"
  RES="$N"
}
# Règle un nouveau contrat (prix + réglages repris de l'ancien), une transaction demandée avant.
regler() { # $1 contrat, $2 nom, $3 prix attendu, $4 arguments JSON
  if [ "$(get "$($AIDE cfg "$1")" price)" = "$3" ]; then echo "      $2 déjà réglé."; return; fi
  echo "      setConfig $4"
  oui "      ⚠️  Envoyer setConfig sur le nouveau $2 depuis main ?" || exit 1
  asentum call "$1" setConfig --from main --args "$4"
  echo -n "      Attente de la confirmation…"
  for i in $(seq 1 36); do sleep 5; [ "$(get "$($AIDE cfg "$1")" price)" = "$3" ] && { echo " ok"; break; }; echo -n "."; done
}

echo "[3/5] Nouveaux contrats…"
LI=$($AIDE info "$OL"); LC=$($AIDE cfg "$OL")
deployer "le nouveau Loto" contrat/loto.deploy.js loto "[\"$(get "$LI" payOwner)\",\"$(get "$LI" payCollab)\",\"$(get "$LI" collabAdmin)\",\"$(get "$LI" tipO)\",\"$(get "$LI" tipC)\",\"$DROP_HEX\"]"
LOTO="$RES"
regler "$LOTO" Loto "$P_LOTO" "[\"$P_LOTO\",$(get "$LC" drawH),$(get "$LC" drawM),$(get "$LC" maxGrids),$(get "$LC" closeMin),$(get "$LC" revealMin),$(get "$LC" maxRound)]"
if [ -f .v5-raffle-deja ]; then
  RAFFLE=$(cat .tombola-v3-fait); echo "      Raffle à 2 ASE déjà en place : $RAFFLE"
else
  RI=$($AIDE info "$OR"); RC=$($AIDE cfg "$OR")
  deployer "la nouvelle Raffle" contrat/tombola.deploy.js raffle "[\"$(get "$RI" payOwner)\",\"$(get "$RI" payCollab)\",\"$(get "$RI" collabAdmin)\",\"$(get "$RI" tipO)\",\"$(get "$RI" tipC)\",\"$DROP_HEX\"]"
  RAFFLE="$RES"
  regler "$RAFFLE" Raffle "$P_RAFFLE" "[\"$P_RAFFLE\",$(get "$RC" drawDay),$(get "$RC" drawH),$(get "$RC" drawM),$(get "$RC" maxPerWallet),$(get "$RC" closeMin),$(get "$RC" revealMin),$(get "$RC" maxRound)]"
fi
TC=$($AIDE cfg "$OT")
deployer "le nouveau Treasure" contrat/tresor.deploy.js tresor "[\"$(get "$TC" operator)\",\"$(get "$TC" payOwner)\",\"$(get "$TC" payCollab)\",\"$DROP_HEX\"]"
TREASURE="$RES"
regler "$TREASURE" Treasure "$P_TRESOR" "[\"$P_TRESOR\",$(get "$TC" maxPerWallet)]"

echo "[4/5] Site, GitHub, Cloudflare et croupiers passent sur les nouveaux contrats…"
SEEDF="croupier/data-tresor/seed-v3.txt"
if [ ! -f "$SEEDF" ]; then node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$SEEDF"; chmod 600 "$SEEDF"; fi
SEED=$(cat "$SEEDF")
echo "      Nouvelle graine des cartes : $SEEDF (à sauvegarder avec tes chaînes ; ne la donne à personne)"
# Contrats en cours (lus par le site, les autres scripts et le rapport des commissions)
echo "$LOTO" > .loto-v4-fait; echo "$RAFFLE" > .tombola-v3-fait; echo "$TREASURE" > .tresor-v2-fait
# Anciens contrats : leurs gains déjà gagnés restent réclamables (« My wins ») ; leurs tickets
# de la semaine comptent encore pour l'Airdrop.
echo "$OL" > .loto-ancien; echo "$OR" > .raffle-ancienne
addold() { local prev; prev=$(cat "$1" 2>/dev/null || true); case ",$prev," in *",$2,"*) ;; *) echo "$2${prev:+,$prev}" > "$1";; esac; }
addold .old-loto "$OL"; addold .old-raffle "$OR"; addold .old-tresor "$OT"
sed -i "s/$OL/$LOTO/g" .github/workflows/croupier.yml
for f in croupier/.env croupier/.env.collab; do [ -f "$f" ] && sed -i "s/^CONTRACT=.*/CONTRACT=$LOTO/" "$f"; done
setvar() { gh api -X PATCH "repos/$R/actions/variables/$1" -f name="$1" -f value="$2" >/dev/null 2>&1 || gh api -X POST "repos/$R/actions/variables" -f name="$1" -f value="$2" >/dev/null; }
printf %s "$SEED" | gh secret set TREASURE_SEED --repo "$R"
setvar CONTRACT "$LOTO"; setvar RAFFLE_CONTRACT "$RAFFLE"; setvar TREASURE_CONTRACT "$TREASURE"
setvar OLD_LOTO "$(cat .old-loto)"; setvar OLD_RAFFLE "$(cat .old-raffle)"; setvar OLD_TREASURE "$(cat .old-tresor)"
echo "      GitHub : variables et graine à jour."
$W whoami 2>/dev/null | grep -qi "logged in" || $W login
TMPJ=$(mktemp); chmod 600 "$TMPJ"
printf '{"TREASURE_SEED":"%s","TREASURE_CONTRACT":"%s"}' "$SEED" "$TREASURE" > "$TMPJ"
if $W pages secret bulk "$TMPJ" --project-name asevegas < /dev/null 2>&1 | grep -v "out-of-date\|wrangler@4\|npx wrangler\|latest version\|^\s*$\|WARNING"; then :; fi
rm -f "$TMPJ"
bash outils/mettre-en-ligne.sh
if systemctl list-unit-files 2>/dev/null | grep -q '^loto-croupier'; then
  echo "      (mot de passe Linux demandé pour relancer les croupiers du PC)"
  sudo systemctl restart loto-croupier loto-croupier-collab 2>/dev/null || true
fi
gh workflow run croupier.yml --repo "$R" >/dev/null 2>&1 || true

echo "[5/5] Remboursements depuis main (liste relue)…"
liste
touch remboursements-faits.txt
if [ -s remboursements.txt ]; then
  while IFS=$'\t' read -r ADDR AMT DETAIL <&3; do
    if grep -qx "$ADDR" remboursements-faits.txt; then echo "      $ADDR : déjà remboursé."; continue; fi
    echo "      $ADDR ← $AMT ASE  ($DETAIL)"
    if oui "      ⚠️  Envoyer $AMT ASE depuis main à $ADDR ?"; then
      asentum send --from main --to "$ADDR" --amount "$AMT"
      echo "$ADDR" >> remboursements-faits.txt
      sleep 3
    else echo "      Pas envoyé (relance ce fichier pour le proposer à nouveau)."; fi
  done 3< remboursements.txt
fi
echo
echo "ASE Loto     : $LOTO   (1 ASE)"
echo "ASE Raffle   : $RAFFLE (2 ASE)"
echo "ASE Treasure : $TREASURE (0,2 ASE)"
echo "Site : https://asevegas.pages.dev/"
