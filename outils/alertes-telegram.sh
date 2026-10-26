#!/usr/bin/env bash
# Alertes Telegram : contrôle anti-bot quotidien du Treasure (et alertes des croupiers).
# Lancé par "Alertes-Telegram.bat". Aucune transaction sur la chaîne.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/loto-ase"
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || { echo "ERREUR : GitHub non connecté (lance Installer-croupiers-GitHub.bat)."; exit 1; }
R="$(gh api user --jq .login)/asegames"
if gh secret list --repo "$R" 2>/dev/null | grep -q '^TELEGRAM_CHAT_ID'; then
  echo "[1/3] Telegram déjà configuré sur GitHub."
  read -r -p "      Le reconfigurer (autre bot ou autre conversation) ? (o/n) " r
  [[ "$r" =~ ^[oOyY] ]] && CONF=1 || CONF=0
else CONF=1; fi
if [ "$CONF" = 1 ]; then
  echo "[1/3] Configuration du bot Telegram"
  echo "      1. Dans Telegram, ouvre @BotFather, envoie /newbot et suis les étapes : il te donne un « token »."
  echo "      2. Ouvre ton nouveau bot et envoie-lui « /start »."
  read -r -s -p "      Colle le token du bot ici (il ne s'affiche pas), puis Entrée : " TOK; echo
  [ -n "$TOK" ] || { echo "ERREUR : token vide."; exit 1; }
  CHAT=$(node -e "fetch('https://api.telegram.org/bot'+process.argv[1]+'/getUpdates').then(r=>r.json()).then(j=>{const m=(j.result||[]).map(u=>u.message||u.channel_post).filter(Boolean).pop();console.log(m?m.chat.id:'')}).catch(()=>console.log(''))" "$TOK")
  [ -n "$CHAT" ] || { echo "ERREUR : aucune conversation trouvée. Envoie « /start » à ton bot dans Telegram, puis relance ce fichier."; exit 1; }
  printf '%s' "$TOK" | gh secret set TELEGRAM_TOKEN --repo "$R" >/dev/null
  printf '%s' "$CHAT" | gh secret set TELEGRAM_CHAT_ID --repo "$R" >/dev/null
  node -e "fetch('https://api.telegram.org/bot'+process.argv[1]+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:process.argv[2],text:'✅ ASE Vegas : alertes Telegram activées.'})})" "$TOK" "$CHAT"
  echo "      Secrets TELEGRAM_TOKEN et TELEGRAM_CHAT_ID enregistrés (message de test envoyé)."
fi
echo "[2/3] Envoi du contrôle anti-bot sur GitHub…"
git add .github/workflows/bot-check.yml croupier/bot-check.mjs croupier/croupier.mjs outils/alertes-telegram.sh
git commit -qm "ASE Vegas: controle anti-bot quotidien" && git push -q || echo "      (rien de nouveau à envoyer)"
sleep 5
echo "[3/3] Premier contrôle lancé maintenant (résultat sur Telegram dans 1 à 2 minutes)…"
gh workflow run bot-check.yml --repo "$R" >/dev/null 2>&1 || echo "      (GitHub n'a pas encore vu le fichier : le contrôle tournera demain à 8 h)"
echo
echo "Tous les jours vers 8 h (heure de Paris), tu reçois le résumé anti-bot du Treasure sur Telegram."
