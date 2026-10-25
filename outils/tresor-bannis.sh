#!/usr/bin/env bash
# ASE Treasure v3 : liste de wallets bannis (tricheurs). Lancé par "Tresor-bannis.bat".
#  - Un wallet banni ne peut plus fouiller, il est bloqué sur toutes les pages d'ASE Vegas
#    et il est retiré des tirages ASE Airdrop qui ont lieu après son bannissement.
#  - On bannit / débannit ensuite depuis l'onglet Admin du trésor (wallet admin).
# Étapes :
#  1. déploie et initialise le trésor v3 (mêmes wallets que le trésor actuel) ;
#  2. bannit les wallets de outils/bannis.txt sur le nouveau contrat ;
#  3. ancien trésor : plus de nouvelle grille (l'opérateur devient ton wallet "main") ; la grille
#     en cours continue jusqu'à son trésor, puis l'ancien contrat est mis en pause ;
#  4. nouvelle graine des grilles, site, GitHub, Cloudflare, mise en ligne.
# ⚠️ Chaque transaction (depuis "main") est demandée (o/n) avant.
# Peut être relancé sans risque : il ne refait jamais une étape déjà faite.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
W="npx --yes wrangler@3"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
get() { node -e "const v=JSON.parse(process.argv[1]);console.log(v==null?'':v['$2'])" "$1"; }
view() { node -e "fetch((process.env.RPC_URL||'https://testnet.asentum.com')+'/view',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contract:process.argv[1],method:process.argv[2],args:JSON.parse(process.argv[3]||'[]')})}).then(r=>r.json()).then(j=>{if(!j.ok)throw new Error(j.reason);console.log(JSON.stringify(j.returnValue))}).catch(e=>{console.error(e.message);process.exit(1)})" "$1" "$2" "${3:-[]}"; }
# attend (10 min max) qu'une lecture JSON vérifie la condition JS sur "v"
attendre() { # $1 contrat, $2 méthode, $3 args, $4 condition
  for _ in $(seq 1 75); do
    V=$(view "$1" "$2" "$3" 2>/dev/null || echo null)
    node -e "const v=JSON.parse(process.argv[1]);process.exit(($4)?0:1)" "$V" && { echo "OK"; return 0; }
    echo -n "."; sleep 8
  done
  echo; echo "ERREUR : pas de confirmation après 10 minutes (regarde l'explorateur, puis relance)."; exit 1
}

npm install --prefix croupier --no-audit --no-fund --silent
[ -f .tresor-v2-fait ] || { echo "ERREUR : .tresor-v2-fait introuvable (adresse du trésor actuel)."; exit 1; }
[ -f outils/bannis.txt ] || { echo "ERREUR : outils/bannis.txt introuvable (wallets à bannir)."; exit 1; }
OLD=$(cat .tresor-v2-fait)
OLD_HEX=$($AIDE hex "$OLD")
TI=$($AIDE cfg "$OLD")
ADMIN=$(get "$TI" admin)
SEEDF="croupier/data-tresor/seed-v3.txt"

echo "[1/6] Nouveau trésor v3 (liste de bannis)…"
NEW=""
if [ -f .tresor-v3-fait ]; then NEW=$(cat .tresor-v3-fait); echo "      Déjà en place : $NEW"
else
  [ -f .tresor-v3-contrat ] && NEW=$(cat .tresor-v3-contrat)
  if [ -z "$NEW" ]; then
    oui "      ⚠️  Déployer contrat/tresor.deploy.js ($(wc -c < contrat/tresor.deploy.js) octets) depuis main ?" || exit 1
    OUT=$(asentum deploy contrat/tresor.deploy.js --from main 2>&1) || true; echo "$OUT"
    NEW=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
    [ -n "$NEW" ] || { echo "ERREUR : adresse du contrat introuvable dans la sortie ci-dessus."; exit 1; }
    echo "$NEW" > .tresor-v3-contrat
    echo -n "      Attente de l'inclusion… "; $AIDE attendre "$NEW" deploye
  fi
  if view "$NEW" getConfig | grep -q admin; then echo "      Déjà initialisé."
  else
    ARGS="[\"$(get "$TI" operator)\",\"$(get "$TI" payOwner)\",\"$(get "$TI" payCollab)\",\"$(get "$TI" payAirdrop)\"]"
    echo "      init $ARGS (mêmes wallets que le trésor actuel)"
    oui "      ⚠️  Envoyer init sur $NEW depuis main ?" || exit 1
    asentum call "$NEW" init --from main --args "$ARGS"
    echo -n "      Attente de la confirmation… "; $AIDE attendre "$NEW" initialise
  fi
  echo "$NEW" > .tresor-v3-fait; rm -f .tresor-v3-contrat
fi
view "$NEW" getConfig | grep -q '"admin":"'"$ADMIN"'"' || { echo "ERREUR : l'admin du nouveau trésor n'est pas celui de l'ancien ($ADMIN)."; exit 1; }

echo "[2/6] Wallets bannis (outils/bannis.txt)…"
LIST=$(grep -oE '(ase1[0-9a-z]{38}|0x[0-9a-fA-F]{40})' outils/bannis.txt | while read -r a; do $AIDE hex "$a"; done | sort -u)
TODO=""
for a in $LIST; do [ "$(view "$NEW" isBanned "[\"$a\"]")" = "true" ] || TODO="$TODO $a"; done
if [ -z "$TODO" ]; then echo "      Déjà bannis : $(echo "$LIST" | wc -w) wallets."
else
  JS=$(node -e "console.log(JSON.stringify([process.argv.slice(1),true]))" $TODO)
  echo "      À bannir :"; for a in $TODO; do echo "        $a"; done
  oui "      ⚠️  Envoyer setBan sur $NEW depuis main ?" || exit 1
  asentum call "$NEW" setBan --from main --args "$JS"
  FIRST=$(echo $TODO | awk '{print $1}')
  echo -n "      Attente de la confirmation… "; attendre "$NEW" isBanned "[\"$FIRST\"]" "v===true"
fi

echo "[3/6] Ancien trésor ($OLD) : plus de nouvelle grille…"
if [ "$(get "$(view "$OLD" getConfig)" operator)" != "$ADMIN" ]; then
  echo "      L'opérateur (croupier GitHub) ne pourra plus ouvrir de grille ; la grille en cours continue."
  oui "      ⚠️  Envoyer setOperator($ADMIN) sur l'ancien trésor depuis main ?" || exit 1
  asentum call "$OLD" setOperator --from main --args "[\"$ADMIN\"]"
  echo -n "      Attente de la confirmation… "; attendre "$OLD" getConfig "[]" "v.operator==='$ADMIN'"
else echo "      Déjà fait."; fi
ST=$(view "$OLD" getState); CUR=$(get "$ST" cur)
G=$(view "$OLD" getGrid "[$CUR]")
STATUS=$(get "$G" status); DIGS=$(get "$G" digs)
# Une grille sans aucune fouille ne contient que le report de la précédente (fouilles faites
# après son trésor) : il n'y a rien à attendre, elle ne se finirait jamais une fois l'ancien
# trésor arrêté. Ce report reste dans l'ancien contrat (il n'a aucune fonction de retrait).
if [ "$STATUS" = "open" ] && [ "$DIGS" != "0" ]; then
  if [ "$(get "$(view "$OLD" getConfig)" paused)" = "true" ]; then
    echo "      ⚠️  La grille n°$CUR de l'ancien trésor a $DIGS fouilles mais le jeu est en pause : elle ne peut pas finir."
    echo "      Remets l'ancien trésor en route (onglet Admin, bouton Resume), attends que son trésor soit trouvé, puis relance ce fichier."
    exit 1
  fi
  echo "      ⏳ La grille n°$CUR de l'ancien trésor est encore en cours ($DIGS fouilles) : son trésor n'a pas été trouvé."
  echo "      Rien d'autre n'a été envoyé. Relance ce fichier quand elle sera finie (environ 20 minutes)."
  exit 3
fi
if [ "$STATUS" = "open" ]; then
  echo "      La grille n°$CUR de l'ancien trésor n'a aucune fouille : elle s'arrête là."
  echo "      Report qui reste dans l'ancien contrat : $(node -e "console.log(Number(BigInt(process.argv[1])/10n**15n)/1000)" "$(get "$G" carryIn)") ASE (fouilles faites après le dernier trésor)."
fi
if [ "$(get "$(view "$OLD" getConfig)" paused)" != "true" ]; then
  oui "      ⚠️  Mettre l'ancien trésor en pause (setPaused) depuis main ?" || exit 1
  asentum call "$OLD" setPaused --from main --args "[true]"
  echo -n "      Attente de la confirmation… "; attendre "$OLD" getConfig "[]" "v.paused===true"
fi

echo "[4/6] Nouvelle graine secrète des grilles (les grilles de l'ancien trésor sont publiques)…"
mkdir -p croupier/data-tresor
if [ ! -f "$SEEDF" ]; then node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$SEEDF"; chmod 600 "$SEEDF"; fi
SEED=$(cat "$SEEDF")
echo "      $SEEDF (à sauvegarder avec tes chaînes ; ne la donne à personne)"

echo "[5/6] Site, GitHub et Cloudflare pointent vers le nouveau trésor…"
sed -i "s|CONTRACT: '[^']*'|CONTRACT: '$NEW'|" tresor/js/config.js
echo "$OLD" > .old-tresor   # ses fouilles de la semaine comptent encore pour l'Airdrop
R=""
setvar() { gh api -X PATCH "repos/$R/actions/variables/$1" -f name="$1" -f value="$2" >/dev/null 2>&1 || gh api -X POST "repos/$R/actions/variables" -f name="$1" -f value="$2" >/dev/null; }
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  R="$(gh api user --jq .login)/asegames"
  printf %s "$SEED" | gh secret set TREASURE_SEED --repo "$R"
  setvar TREASURE_CONTRACT "$NEW"; setvar OLD_TREASURE "$OLD"
  git add -A
  if git diff --cached --name-only | grep -E '(-chain\.json|gh-signers\.json|seed.*\.txt|(^|/)\.env($|\.)|croupier/data)' | grep -v '\.env\.exemple$'; then
    echo "ERREUR : un fichier secret allait être publié. Arrêt."; exit 1
  fi
  git commit -qm "Treasure v3: banned wallets" || true
  git push -q
  echo "      GitHub à jour."
else
  echo "⚠️  GitHub non connecté : lance Installer-croupiers-GitHub.bat, puis relance ce fichier."; exit 1
fi
$W whoami 2>/dev/null | grep -qi "logged in" || $W login
TMPJ=$(mktemp); chmod 600 "$TMPJ"
printf '{"TREASURE_SEED":"%s","TREASURE_CONTRACT":"%s"}' "$SEED" "$NEW" > "$TMPJ"
$W pages secret bulk "$TMPJ" --project-name asevegas < /dev/null 2>&1 | grep -v "out-of-date\|wrangler@4\|npx wrangler\|latest version\|^\s*$\|WARNING" || true
rm -f "$TMPJ"
bash outils/mettre-en-ligne.sh

echo "[6/6] Le croupier GitHub ouvre la 1re grille du nouveau trésor…"
gh workflow run croupier.yml --repo "$R" >/dev/null 2>&1 || true
echo
echo "ASE Treasure v3 : $NEW"
echo "Bannis : $(view "$NEW" getBans | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).length))") wallets"
echo "Pour bannir d'autres wallets : onglet Admin du trésor sur le site, avec ton wallet admin."
