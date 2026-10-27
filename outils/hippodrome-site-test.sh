#!/usr/bin/env bash
# Ajoute la page Hippodrome (v3) au SITE DE TEST assemblé ($1 = dossier, ex. asegame-test) :
# copie de hippodrome/ avec les adresses des contrats de test, lien « Hippodrome » dans le menu
# de chaque page et carte sur l'accueil. Lancé par mettre-en-ligne-test.sh. Le vrai site n'est pas touché.
set -euo pipefail
cd "$HOME/loto-ase"
D="$1"
[ -d "$D" ] && [ -f .test-hippo3-paris ] && [ -f .test-hippo3-ecurie ] || exit 0
rm -rf "$D/hippodrome" && cp -r hippodrome "$D/hippodrome"
sed -i "s|ECURIE: '[^']*'|ECURIE: '$(cat .test-hippo3-ecurie)'|; s|PARIS: '[^']*'|PARIS: '$(cat .test-hippo3-paris)'|" "$D/hippodrome/js/config.js"
for f in $(find "$D" -name index.html -not -path "*/hippodrome/*"); do
  grep -q 'hippodrome/">Hippodrome' "$f" || sed -i 's#<a href="\(\.\./\|\./\)airdrop/"\([^>]*\)>Airdrop</a>#<a href="\1hippodrome/">Hippodrome</a>&#' "$f"
done
CARD='<a class="gcard hippodrome" data-game="hippodrome" href="hippodrome/"><div class="g-art" aria-hidden="true"><svg viewBox="0 0 150 110" width="150" height="110"><rect x="0" y="78" width="150" height="32" fill="#1d5a33"/><path d="M0 78 H150" stroke="#f2f2ee" stroke-width="3"/><g fill="#F09A58"><path d="M28 70c6-16 20-24 40-24h22l12-12 6 3-4 9c6 3 10 9 10 16l-6 2-4-8-6 4 4 18h-6l-5-15-22 2-6 15h-6l2-17c-6 0-12 4-14 9z"/></g><circle cx="72" cy="30" r="6" fill="#F4C542"/><path d="M66 38l12 2-4 10-10-2z" fill="#3DDC6B"/></svg></div><div class="g-head"><span>New · test site</span><span class="hot">Own a horse</span></div><div class="g-body"><div class="g-title"><h2>Hippodrome</h2><span class="g-val">19:00 <small>Paris, daily</small></span></div><p class="desc">Buy a racehorse, feed it, train it and enter it in the daily race: the winner&#39;s owner takes 90% of the pot. Or just bet and watch the race in 3D.</p><div class="chips"><span class="chip-i">Horses from 10 ASE</span><span class="chip-i">Entry 5 ASE</span></div><span class="btn btn-primary btn-wide">Go to the stables</span></div></a>'
python3 - "$D/index.html" "$CARD" <<'PY'
import sys, re
p, card = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8').read()
s = re.sub(r'<a class="gcard hippodrome".*?</a>(?=\s*<a class="gcard|\s*</section>)', '', s, flags=re.S)   # ancienne carte (v2)
k = s.find('<a class="gcard airdrop"')
s = s[:k] + card + '\n    ' + s[k:] if k >= 0 else s.replace('</section>\n</main>', card + '\n  </section>\n</main>', 1)
open(p, 'w', encoding='utf-8').write(s)
PY
echo "      Hippodrome v3 ajouté au site de test (écurie $(cat .test-hippo3-ecurie), paris $(cat .test-hippo3-paris))."
