#!/usr/bin/env bash
# Passe ASE Loto sur le nouveau contrat (5 numéros sur 20, 2 ASE, commission 20 % 75/25,
# gains fixes + bonus, tirage 21h). Lancé par "Deployer-nouveau-loto.bat".
# ⚠️ Envoie 3 transactions depuis ton compte "main" : chacune est demandée (o/n) avant.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="${AIDE:-node outils/loto-aide.mjs}"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
PAY_COLLAB_ASE1="ase1ludcdjwrnfdfl6wujdahvkrsxst6vtve7qs3kw"

OLD="ase15nquypra8kvqkkkaj4k2umje2d9sa0s0jyaxlm"      # ancien contrat (v1)
CFG=$(grep -o "ase1[0-9a-z]\{38\}" site/js/config.js | head -1)
[ -f .loto-v2-contrat ] && NEW=$(cat .loto-v2-contrat) || NEW=""
[ -z "$NEW" ] && [ "$CFG" != "$OLD" ] && NEW="$CFG"   # contrat v2 déjà connu du site
if [ -f .loto-v2-fait ]; then
  # Déjà fait : on ne redéploie JAMAIS ; on remet seulement le site et les croupiers à jour.
  NEW=$(cat .loto-v2-fait)
  echo "Le nouveau contrat est déjà en place ($NEW) : simple remise à jour du site et des croupiers."
  SKIP=1
else SKIP=0; fi
if [ "$SKIP" = 0 ]; then
echo "[1/7] Lecture de l'ancien contrat ($OLD)…"
INFO=$($AIDE info "$OLD")
get() { node -e "console.log(JSON.parse(process.argv[1])['$1'])" "$INFO"; }
PAY_OWNER=$(get payOwner); COLLAB_ADMIN=$(get collabAdmin); TIPO=$(get tipO); TIPC=$(get tipC)
PAY_COLLAB=$($AIDE hex "$PAY_COLLAB_ASE1")
echo "      commission owner (75 %)   : $PAY_OWNER (inchangé)"
echo "      commission collab (25 %)  : $PAY_COLLAB ($PAY_COLLAB_ASE1)"
echo "      gestion chaîne collab     : $COLLAB_ADMIN (inchangé)"
echo "      chaînes de secrets        : on reprend les mêmes (rien à changer pour les croupiers)"
if [ "$(get owed)" != "0" ] || [ "$(get enAttente)" != "0" ] || [ "$(get grillesTourEnCours)" != "0" ]; then
  echo "⚠️  L'ancien contrat a encore des grilles ou des gains/remboursements en attente :"
  echo "    $INFO"
  oui "      Continuer quand même ? (non conseillé : attends que les croupiers aient fini)" || exit 1
fi

echo "[2/7] Mise en pause de l'ancien contrat (plus personne ne peut y acheter)…"
if [ "$(get paused)" = "true" ]; then echo "      Déjà en pause."
elif oui "      ⚠️  Envoyer la transaction setPaused(true) sur l'ancien contrat depuis main ?"; then
  asentum call "$OLD" setPaused --from main --args '[true]'
  $AIDE attendre "$OLD" pause
else echo "      Pas de pause (l'ancien contrat reste ouvert)."; fi

if [ -z "$NEW" ]; then
  echo "[3/7] Déploiement du nouveau contrat ($(wc -c < contrat/loto.deploy.js) octets)…"
  oui "      ⚠️  Déployer contrat/loto.deploy.js depuis main ?" || exit 1
  OUT=$(asentum deploy contrat/loto.deploy.js --from main 2>&1 | tee /dev/stderr)
  NEW=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
  [ -n "$NEW" ] || { echo "ERREUR : adresse du nouveau contrat introuvable dans la sortie ci-dessus."; exit 1; }
  echo "$NEW" > .loto-v2-contrat
  echo -n "      Attente de l'inclusion du déploiement… "; $AIDE attendre "$NEW" deploye
else
  echo "[3/7] Nouveau contrat déjà déployé : $NEW"
fi

echo "[4/7] Initialisation du nouveau contrat…"
if node -e "fetch((process.env.RPC_URL||'https://testnet.asentum.com')+'/view',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contract:'$NEW',method:'getConfig',args:[]})}).then(r=>r.json()).then(j=>process.exit(j.returnValue?0:1))"; then
  echo "      Déjà initialisé."
else
  ARGS="[\"$PAY_OWNER\",\"$PAY_COLLAB\",\"$COLLAB_ADMIN\",\"$TIPO\",\"$TIPC\"]"
  oui "      ⚠️  Envoyer init sur $NEW depuis main ?" || exit 1
  asentum call "$NEW" init --from main --args "$ARGS"
  echo -n "      Attente de la confirmation… "; $AIDE attendre "$NEW" initialise
fi
NI=$($AIDE info "$NEW"); echo "      $NI"
echo "$NEW" > .loto-v2-fait
fi

echo "[5/7] Site, croupiers du PC et GitHub pointent vers le nouveau contrat…"
sed -i "s/$OLD/$NEW/g" site/js/config.js .github/workflows/croupier.yml
for f in croupier/.env croupier/.env.collab; do [ -f "$f" ] && sed -i "s/^CONTRACT=.*/CONTRACT=$NEW/" "$f"; done
R=""
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  R="$(gh api user --jq .login)/asegames"
  gh api -X PATCH "repos/$R/actions/variables/CONTRACT" -f name=CONTRACT -f value="$NEW" >/dev/null 2>&1 \
    || gh api -X POST "repos/$R/actions/variables" -f name=CONTRACT -f value="$NEW" >/dev/null
  git add -A
  if git diff --cached --name-only | grep -E '(-chain\.json|gh-signers\.json|(^|/)\.env($|\.)|croupier/data)' | grep -v '\.env\.exemple$'; then
    echo "ERREUR : un fichier secret allait être publié. Arrêt."; exit 1
  fi
  git commit -qm "ASE Loto v2 : 5 numbers out of 20, 2 ASE, fixed prizes + bonus, English site" || true
  git push -q
  echo "      GitHub mis à jour ($R)."
fi

echo "[6/7] Mise en ligne du site…"
bash outils/mettre-en-ligne.sh

echo "[7/7] Relance des croupiers…"
if systemctl list-unit-files 2>/dev/null | grep -q '^loto-croupier'; then
  echo "      (mot de passe Linux demandé)"
  sudo systemctl restart loto-croupier loto-croupier-collab 2>/dev/null || true
fi
[ -n "${R:-}" ] && gh workflow run croupier.yml --repo "$R" >/dev/null 2>&1 || true
rm -f .loto-v2-contrat
echo
echo "Nouveau contrat : $NEW"
echo "Premier tirage : demain 21h00 (heure de Paris), ou ce soir si les ventes ne sont pas encore fermées."
