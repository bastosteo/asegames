#!/usr/bin/env bash
# ASE Vegas « sans remboursement » : loto v4, tombola v3, trésor v2.
# Lancé par "Mettre-a-jour-ASE-Vegas-v4.bat".
#  - Commission de 15 % prise à CHAQUE achat (7,5 % envoyés tout de suite à l'Airdrop).
#  - Plus aucune annulation ni remboursement : un tirage attend ses secrets.
#  - Tombola : moins de 3 joueurs → tirage quand même, prix sans gagnant reportés.
#  - Trésor : les fouilles après le trésor vont dans la grille suivante.
# Étapes :
#  1. termine les anciens contrats (pause ; DERNIER remboursement du tirage / de la grille en
#     cours, car l'argent d'un ancien contrat ne peut pas passer dans le nouveau ; envoi des
#     gains pas encore réclamés) ;
#  2. déploie et initialise les 3 nouveaux contrats (mêmes wallets, mêmes chaînes de secrets ;
#     nouvelle graine secrète pour les grilles du trésor) ;
#  3. met à jour le site, GitHub, Cloudflare et les croupiers du PC.
# L'ASE Airdrop ne change pas. ⚠️ Chaque transaction (depuis "main") est demandée (o/n) avant.
# Peut être relancé sans risque : il ne refait jamais une étape déjà faite.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
MIG="node outils/migration.mjs"
GH_AIDE="node croupier/github-aide.mjs"
W="npx --yes wrangler@3"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }

npm install --prefix croupier --no-audit --no-fund --silent
for f in .loto-v3-fait .tombola-v2-fait .tresor-fait .airdrop-fait; do
  [ -f "$f" ] || { echo "ERREUR : fichier $f introuvable (adresse d'un contrat actuel)."; exit 1; }
done
[ -f croupier/data/gh-signers.json ] || { echo "ERREUR : croupier/data/gh-signers.json introuvable (Installer-croupiers-GitHub.bat)."; exit 1; }
OLD_LOTO=$(cat .loto-v3-fait); OLD_RAFFLE=$(cat .tombola-v2-fait); OLD_TREASURE=$(cat .tresor-fait); AIRDROP=$(cat .airdrop-fait)
DROP_HEX=$($AIDE hex "$AIRDROP")
OLD_SEEDF="croupier/data-tresor/seed.txt"; SEEDF="croupier/data-tresor/seed-v2.txt"

# Termine un ancien contrat : une transaction à la fois, chacune demandée avant.
migrer() { # $1 = contrat, $2 = loto|raffle|treasure, $3 = nom, $4 = marqueur
  if [ -f "$4" ]; then echo "      Déjà fait."; return; fi
  while :; do
    LINE=$(TREASURE_SEED="$( [ -f "$OLD_SEEDF" ] && cat "$OLD_SEEDF" )" $MIG plan "$1" "$2" | head -1)
    [ -z "$LINE" ] && break
    IFS=$'\t' read -r M A D <<< "$LINE"
    if [ "$M" = "ATTENTE" ]; then
      echo "      ⏳ $3 : $A."
      echo "      Rien d'autre n'a été envoyé. Relance ce fichier dans 30 minutes environ."
      exit 3
    fi
    echo "      → $D"
    oui "      ⚠️  Envoyer $M $A sur l'ancien contrat ($3) depuis main ?" || { echo "      Arrêt demandé : rien d'autre n'a été envoyé."; exit 1; }
    asentum call "$1" "$M" --from main --args "$A"
    echo -n "      Attente de la confirmation… "; TREASURE_SEED="$( [ -f "$OLD_SEEDF" ] && cat "$OLD_SEEDF" )" $MIG attendre "$1" "$2" "$M" "$A"
  done
  touch "$4"
  echo "      $3 : terminé (en pause, plus rien en attente)."
}

est_initialise() { node -e "fetch((process.env.RPC_URL||'https://testnet.asentum.com')+'/view',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contract:'$1',method:'getConfig',args:[]})}).then(r=>r.json()).then(j=>process.exit(j.returnValue?0:1)).catch(()=>process.exit(1))"; }

# Déploie puis initialise un contrat. Résultat (adresse) dans RES.
deployer() { # $1 = nom, $2 = fichier, $3 = marqueur, $4 = arguments de init (JSON)
  local nom="$1" f="$2" m="$3" args="$4" N=""
  if [ -f ".$m-fait" ]; then RES=$(cat ".$m-fait"); echo "      $nom déjà en place : $RES"; return; fi
  [ -f ".$m-contrat" ] && N=$(cat ".$m-contrat")
  if [ -z "$N" ]; then
    oui "      ⚠️  Déployer $nom ($f, $(wc -c < "$f") octets) depuis main ?" || exit 1
    OUT=$(asentum deploy "$f" --from main 2>&1) || true; echo "$OUT"
    N=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
    [ -n "$N" ] || { echo "ERREUR : adresse du contrat introuvable dans la sortie ci-dessus."; exit 1; }
    echo "$N" > ".$m-contrat"
    echo -n "      Attente de l'inclusion… "; $AIDE attendre "$N" deploye
  else
    echo "      $nom déjà déployé : $N"
  fi
  if est_initialise "$N"; then echo "      Déjà initialisé."
  else
    echo "      init $args"
    oui "      ⚠️  Envoyer init sur $N depuis main ?" || exit 1
    asentum call "$N" init --from main --args "$args"
    echo -n "      Attente de la confirmation… "; $AIDE attendre "$N" initialise
  fi
  echo "$N" > ".$m-fait"; rm -f ".$m-contrat"
  RES="$N"
}

echo "[1/7] Ancien loto ($OLD_LOTO)…"
migrer "$OLD_LOTO" loto "ancien loto" .migre-loto-v3
echo "[2/7] Ancienne tombola ($OLD_RAFFLE)…"
migrer "$OLD_RAFFLE" raffle "ancienne tombola" .migre-raffle-v2
echo "      Ancien trésor ($OLD_TREASURE)…"
migrer "$OLD_TREASURE" treasure "ancien trésor" .migre-tresor-v1

# Réglages repris des anciens contrats (mêmes wallets, mêmes chaînes de secrets)
LI=$($AIDE info "$OLD_LOTO"); RI=$($AIDE info "$OLD_RAFFLE"); TI=$($AIDE cfg "$OLD_TREASURE")
get() { node -e "console.log(JSON.parse(process.argv[1])['$2'])" "$1"; }

echo "[3/7] Nouveau loto (v4)…"
deployer "le loto v4" contrat/loto.deploy.js loto-v4 "[\"$(get "$LI" payOwner)\",\"$(get "$LI" payCollab)\",\"$(get "$LI" collabAdmin)\",\"$(get "$LI" tipO)\",\"$(get "$LI" tipC)\",\"$DROP_HEX\"]"
LOTO="$RES"
echo "      Nouvelle tombola (v3)…"
deployer "la tombola v3" contrat/tombola.deploy.js tombola-v3 "[\"$(get "$RI" payOwner)\",\"$(get "$RI" payCollab)\",\"$(get "$RI" collabAdmin)\",\"$(get "$RI" tipO)\",\"$(get "$RI" tipC)\",\"$DROP_HEX\"]"
RAFFLE="$RES"
echo "      Nouveau trésor (v2)…"
deployer "le trésor v2" contrat/tresor.deploy.js tresor-v2 "[\"$(get "$TI" operator)\",\"$(get "$TI" payOwner)\",\"$(get "$TI" payCollab)\",\"$DROP_HEX\"]"
TREASURE="$RES"

echo "[4/7] Nouvelle graine secrète des grilles du trésor (les anciennes grilles sont publiques)…"
if [ ! -f "$SEEDF" ]; then node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$SEEDF"; chmod 600 "$SEEDF"; fi
SEED=$(cat "$SEEDF")
echo "      $SEEDF (à sauvegarder avec tes chaînes ; ne la donne à personne)"

echo "[5/7] Site et croupiers pointent vers les nouveaux contrats…"
sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$LOTO'|" site/js/config.js
sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$RAFFLE'|" tombola/js/config.js
sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$TREASURE'|" tresor/js/config.js
sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$AIRDROP'|" airdrop/js/config.js
# Anciens contrats : leurs tickets comptent encore pour l'Airdrop de cette semaine
sed -i "s|OLD_LOTO: '[^']*', OLD_RAFFLE: '[^']*', OLD_TREASURE: '[^']*'|OLD_LOTO: '$OLD_LOTO', OLD_RAFFLE: '$OLD_RAFFLE', OLD_TREASURE: '$OLD_TREASURE'|" airdrop/js/config.js
echo "$OLD_LOTO" > .old-loto; echo "$OLD_RAFFLE" > .old-raffle; echo "$OLD_TREASURE" > .old-tresor
sed -i "s/$OLD_LOTO/$LOTO/g" .github/workflows/croupier.yml
for f in croupier/.env croupier/.env.collab; do [ -f "$f" ] && sed -i "s/^CONTRACT=.*/CONTRACT=$LOTO/" "$f"; done
R=""
setvar() { gh api -X PATCH "repos/$R/actions/variables/$1" -f name="$1" -f value="$2" >/dev/null 2>&1 || gh api -X POST "repos/$R/actions/variables" -f name="$1" -f value="$2" >/dev/null; }
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  R="$(gh api user --jq .login)/asegames"
  printf %s "$SEED" | gh secret set TREASURE_SEED --repo "$R"
  setvar CONTRACT "$LOTO"; setvar RAFFLE_CONTRACT "$RAFFLE"; setvar TREASURE_CONTRACT "$TREASURE"
  setvar OLD_LOTO "$OLD_LOTO"; setvar OLD_RAFFLE "$OLD_RAFFLE"; setvar OLD_TREASURE "$OLD_TREASURE"
  git add -A
  if git diff --cached --name-only | grep -E '(-chain\.json|gh-signers\.json|seed.*\.txt|(^|/)\.env($|\.)|croupier/data)' | grep -v '\.env\.exemple$'; then
    echo "ERREUR : un fichier secret allait être publié. Arrêt."; exit 1
  fi
  git commit -qm "No refunds: fee on every purchase, raffle and treasure carry-over" || true
  git push -q
  echo "      GitHub à jour."
else
  echo "⚠️  GitHub non connecté : lance Installer-croupiers-GitHub.bat, puis relance ce fichier."
fi

echo "[6/7] Cloudflare (service de réponses du trésor) et mise en ligne du site…"
$W whoami 2>/dev/null | grep -qi "logged in" || $W login
TMPJ=$(mktemp); chmod 600 "$TMPJ"
printf '{"TREASURE_SEED":"%s","TREASURE_CONTRACT":"%s"}' "$SEED" "$TREASURE" > "$TMPJ"
if $W pages secret bulk "$TMPJ" --project-name asevegas < /dev/null 2>&1 | grep -v "out-of-date\|wrangler@4\|npx wrangler\|latest version\|^\s*$\|WARNING"; then :; fi
rm -f "$TMPJ"
bash outils/mettre-en-ligne.sh

echo "[7/7] Relance des croupiers…"
if systemctl list-unit-files 2>/dev/null | grep -q '^loto-croupier'; then
  echo "      (mot de passe Linux demandé)"
  sudo systemctl restart loto-croupier loto-croupier-collab 2>/dev/null || true
fi
[ -n "$R" ] && gh workflow run croupier.yml --repo "$R" >/dev/null 2>&1 || true
echo
echo "ASE Loto     : $LOTO"
echo "ASE Raffle   : $RAFFLE"
echo "ASE Treasure : $TREASURE"
echo "Site : https://asevegas.pages.dev/"
