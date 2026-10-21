#!/usr/bin/env bash
# Nouveau Loto v7 : par défaut 5 numéros sur 15, 2 ASE, 2 000 grilles max par tirage, 15 par joueur ;
# nombre de numéros, plafond par tirage et par joueur modifiables à tout moment dans le panneau Admin.
# Commission 9 % équipe / 6 % Airdrop,
# SANS fonction de prélèvement. Lancé par "Nouveau-Loto-15.bat", APRÈS le tirage du soir.
# Si tu as lancé "Recuperer-jackpot.bat" avant le tirage, le jackpot récupéré est proposé à l'étape 3.
# Étapes (chaque transaction depuis "main" est demandée o/n avant ; relançable sans risque) :
#  1. vérifie qu'aucun tirage n'est en cours sur le Loto actuel, puis le met en pause ;
#  2. déploie, initialise et règle le nouveau Loto (mêmes wallets, mêmes chaînes de secrets) ;
#  3. (option) remet de l'ASE dans le jackpot du nouveau Loto ;
#  4. site, GitHub et croupiers passent sur le nouveau Loto ;
#  5. rembourse ceux qui avaient déjà acheté une grille du tirage en cours (s'il y en a).
# Les gains déjà gagnés sur l'ancien Loto restent réclamables (« My wins »). Son jackpot y reste
# (aucun contrat n'a de fonction de retrait).
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.asentum/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
AIDE="node outils/loto-aide.mjs"
RB="node outils/rembourser.mjs"
oui() { local r; read -r -p "$1 (o/n) " r; [[ "$r" =~ ^[oOyY] ]]; }
get() { node -e "const v=JSON.parse(process.argv[1]);console.log(v==null||v['$2']==null?'':v['$2'])" "$1"; }
ase() { node -e "const s=BigInt(process.argv[1]).toString().padStart(19,'0');console.log((s.slice(0,-18)+'.'+s.slice(-18)).replace(/\.?0+$/,''))" "$1"; }
P_LOTO=2000000000000000000

npm install --prefix croupier --no-audit --no-fund --silent
for f in .loto-v4-fait .airdrop-fait; do [ -f "$f" ] || { echo "ERREUR : fichier $f introuvable."; exit 1; }; done
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || { echo "ERREUR : GitHub non connecté (lance Installer-croupiers-GitHub.bat)."; exit 1; }
R="$(gh api user --jq .login)/asegames"
DROP_HEX=$($AIDE hex "$(cat .airdrop-fait)")
[ -f .v8-ancien-loto ] || cp .loto-v4-fait .v8-ancien-loto
OL=$(cat .v8-ancien-loto)
echo "Loto actuel : $OL"
[ -n "$(get "$($AIDE info "$OL")" roundMaxn)" ] && { echo "Le Loto actuel est déjà le Loto à 15 numéros (limite par joueur) : rien à faire."; exit 0; }
grep -q skim contrat/loto.deploy.js && { echo "ERREUR : contrat/loto.deploy.js contient encore le prélèvement (ancien zip ?). Rien n'a été envoyé."; exit 1; }
grep -q nextMaxn contrat/loto.deploy.js || { echo "ERREUR : contrat/loto.deploy.js n'est pas le Loto à 15 numéros (ancien zip ?). Rien n'a été envoyé."; exit 1; }

echo "[1/5] Vérification puis pause du Loto actuel…"
V=$($RB verifier "$OL" - -)   # tirage du soir terminé ? (même si l'ancien Loto est déjà en pause)
HR=$($AIDE heures "$OL")   # juste après le tirage du soir, le prochain tirage est dans ~24 h
if [ "${HR:-0}" -lt 20 ] && [ ! -f .v8-loto ] && [ ! -f .v8-loto-contrat ]; then echo "      ⏳ Le tirage du soir n'a pas encore eu lieu (prochain tirage dans ${HR} h). Rien n'a été envoyé : relance ce fichier après le tirage de 21 h."; exit 3; fi
if [ "$V" != "OK" ] && [ ! -f .v8-loto ] && [ ! -f .v8-loto-contrat ]; then echo "      ⏳ ${V#ATTENTE	}. Rien n'a été envoyé : relance ce fichier après le tirage."; exit 3; fi
if [ "$(get "$($AIDE cfg "$OL")" paused)" != "true" ]; then
  oui "      ⚠️  Envoyer setPaused [true] sur le Loto actuel depuis main ?" || { echo "      Arrêt demandé : rien n'a été envoyé."; exit 1; }
  asentum call "$OL" setPaused --from main --args '[true]'
  echo -n "      Attente de la confirmation… "; $AIDE attendre "$OL" pause
else echo "      Déjà en pause."; fi
$RB liste "$OL" - - > remboursements-loto.txt
if [ -s remboursements-loto.txt ]; then echo "      Grilles du tirage en cours à rembourser à la fin :"; awk -F'\t' '{ printf "        %s  %s ASE  (%s)\n", $1, $2, $3 }' remboursements-loto.txt
else echo "      Personne n'a encore acheté de grille du tirage en cours : rien à rembourser."; fi

echo "[2/5] Nouveau Loto…"
LI=$($AIDE info "$OL"); LC=$($AIDE cfg "$OL")
N=""; [ -f .v8-loto ] && N=$(cat .v8-loto)
[ -z "$N" ] && [ -f .v8-loto-contrat ] && N=$(cat .v8-loto-contrat)
if [ -z "$N" ]; then
  oui "      ⚠️  Déployer le nouveau Loto (contrat/loto.deploy.js, $(wc -c < contrat/loto.deploy.js) octets) depuis main ?" || exit 1
  OUT=$(asentum deploy contrat/loto.deploy.js --from main 2>&1) || true; echo "$OUT"
  N=$(printf '%s' "$OUT" | grep -iE "live at|contract address" | grep -o "ase1[0-9a-z]\{38\}" | tail -1)
  [ -n "$N" ] || { echo "ERREUR : adresse du contrat introuvable dans la sortie ci-dessus."; exit 1; }
  echo "$N" > .v8-loto-contrat
  echo -n "      Attente de l'inclusion… "; $AIDE attendre "$N" deploye
else echo "      Déjà déployé : $N"; fi
if [ -z "$(get "$($AIDE cfg "$N")" admin)" ]; then
  A="[\"$(get "$LI" payOwner)\",\"$(get "$LI" payCollab)\",\"$(get "$LI" collabAdmin)\",\"$(get "$LI" tipO)\",\"$(get "$LI" tipC)\",\"$DROP_HEX\"]"
  echo "      init $A"
  oui "      ⚠️  Envoyer init sur $N depuis main ?" || exit 1
  asentum call "$N" init --from main --args "$A"
  echo -n "      Attente de la confirmation… "; $AIDE attendre "$N" initialise
else echo "      Déjà initialisé."; fi
echo "$N" > .v8-loto; rm -f .v8-loto-contrat
C=$($AIDE cfg "$N")
if [ "$(get "$C" price)" = "$P_LOTO" ] && [ "$(get "$C" closeMin)" = "$(get "$LC" closeMin)" ] && [ "$(get "$C" drawH)" = "$(get "$LC" drawH)" ]; then echo "      Déjà réglé (2 ASE, mêmes horaires)."
else
  A="[\"$P_LOTO\",$(get "$LC" drawH),$(get "$LC" drawM),15,$(get "$LC" closeMin),$(get "$LC" revealMin),2000,15,15]"
  echo "      setConfig $A   (2 ASE la grille, 2 000 grilles max par tirage, 15 par joueur, numéros 1 à 15 ; mêmes horaires que l'ancien Loto)"
  oui "      ⚠️  Envoyer setConfig sur le nouveau Loto depuis main ?" || exit 1
  asentum call "$N" setConfig --from main --args "$A"
  echo -n "      Attente de la confirmation…"
  for i in $(seq 1 36); do sleep 5; [ "$(get "$($AIDE cfg "$N")" closeMin)" = "$(get "$LC" closeMin)" ] && { echo " ok"; break; }; echo -n "."; done
fi
C=$($AIDE cfg "$N")
echo "      Nouveau Loto : 5 numéros sur 15, 15 grilles max par joueur et par tirage, aucun prélèvement."

# Nouveau Loto en pause tant que Milkie n'a pas mis à jour la quête (bouton « Resume game » du panneau Admin ensuite)
if [ ! -f .v8-pause-fait ]; then
  if [ "$(get "$($AIDE cfg "$N")" paused)" != "true" ]; then
    if oui "      ⚠️  Mettre le nouveau Loto en pause (setPaused [true]) en attendant la mise à jour de Milkie ?"; then
      asentum call "$N" setPaused --from main --args '[true]'
      echo -n "      Attente de la confirmation… "; $AIDE attendre "$N" pause
    fi
  fi
  touch .v8-pause-fait
fi
echo "[3/5] Jackpot de départ…"
OJ=$(get "$LI" jackpot)
SK=$($AIDE prelevement "$OL" 2>/dev/null || echo 0)
TOT=$(node -e "console.log((BigInt(process.argv[1])+BigInt(process.argv[2])).toString())" "$OJ" "$SK")
if [ -f .v8-loto-fund ]; then echo "      Déjà fait."
else
  echo "      Jackpot resté dans l'ancien Loto (bloqué) : $(ase "$OJ") ASE"
  echo "      Récupéré dans ton wallet au dernier tirage (prélèvement) : $(ase "$SK") ASE"
  echo "      Pour que les joueurs retrouvent le même jackpot, remets $(ase "$TOT") ASE (récupéré + resté bloqué)."
  read -r -p "      Montant en ASE à ajouter (0 ou Entrée = rien) : " AMT
  AMT=${AMT:-0}; AMT=${AMT/,/.}
  if [ "$AMT" != "0" ]; then
    H=$(asentum call --help 2>&1 || true)
    if printf '%s' "$H" | grep -q -- '--value'; then OPT=--value
    elif printf '%s' "$H" | grep -q -- '--amount'; then OPT=--amount
    else echo "      La CLI ne dit pas comment joindre de l'ASE à un appel : étape passée (copie ce texte à Claude)."; echo "$H"; OPT=""; fi
    if [ -n "$OPT" ] && oui "      ⚠️  Envoyer $AMT ASE depuis main dans le jackpot du nouveau Loto (fund) ?"; then
      asentum call "$N" fund --from main --args '[]' $OPT "$AMT"
    fi
  fi
  touch .v8-loto-fund
fi

echo "[4/5] Site, GitHub et croupiers passent sur le nouveau Loto…"
echo "$N" > .loto-v4-fait          # contrat Loto en cours (lu par le site et les autres scripts)
PA=$(cat .loto-ancien 2>/dev/null || true)
case ",$PA," in *",$OL,"*) ;; *) echo "$OL${PA:+,$PA}" > .loto-ancien;; esac   # anciens Loto : gains déjà gagnés toujours réclamables (« My wins »)
PREV=$(cat .old-loto 2>/dev/null || true)
case ",$PREV," in *",$OL,"*) ;; *) echo "$OL${PREV:+,$PREV}" > .old-loto;; esac
sed -i "s/$OL/$N/g" .github/workflows/croupier.yml
for f in croupier/.env croupier/.env.collab; do [ -f "$f" ] && sed -i "s/^CONTRACT=.*/CONTRACT=$N/" "$f"; done
setvar() { gh api -X PATCH "repos/$R/actions/variables/$1" -f name="$1" -f value="$2" >/dev/null 2>&1 || gh api -X POST "repos/$R/actions/variables" -f name="$1" -f value="$2" >/dev/null; }
setvar CONTRACT "$N"; setvar OLD_LOTO "$(cat .old-loto)"
echo "      GitHub : CONTRACT = $N"
bash outils/mettre-en-ligne.sh
if systemctl list-unit-files 2>/dev/null | grep -q '^loto-croupier'; then
  echo "      (mot de passe Linux demandé pour relancer les croupiers du PC)"
  sudo systemctl restart loto-croupier loto-croupier-collab 2>/dev/null || true
fi
gh workflow run croupier.yml --repo "$R" >/dev/null 2>&1 || true

echo "[5/5] Remboursements (grilles du tirage en cours de l'ancien Loto)…"
$RB liste "$OL" - - > remboursements-loto.txt
touch remboursements-faits.txt
if [ -s remboursements-loto.txt ]; then
  while IFS=$'\t' read -r ADDR AMT DETAIL <&3; do
    if grep -qx "loto:$ADDR" remboursements-faits.txt; then echo "      $ADDR : déjà remboursé."; continue; fi
    echo "      $ADDR ← $AMT ASE  ($DETAIL)"
    if oui "      ⚠️  Envoyer $AMT ASE depuis main à $ADDR ?"; then
      for essai in 1 2 3; do asentum send --from main --to "$ADDR" --amount "$AMT" && break; [ $essai = 3 ] && exit 1; echo "      (nouvel essai dans 15 s…)"; sleep 15; done
      echo "loto:$ADDR" >> remboursements-faits.txt; echo "      (attente du bloc suivant…)"; sleep 15
    else echo "      Pas envoyé (relance ce fichier pour le proposer à nouveau)."; fi
  done 3< remboursements-loto.txt
else echo "      Personne à rembourser."; fi
echo
echo "Nouveau Loto : $N (5 numéros sur 15, 2 ASE la grille, 15 grilles max par joueur et par tirage)"
echo "Site : https://asevegas.com/loto/"
echo
echo "⏸️  Le nouveau Loto est EN PAUSE : envoie son adresse ($N) à Milkie."
echo "   Quand Milkie a mis la quête à jour : asevegas.com/loto/ → panneau Admin → « Resume game »."
