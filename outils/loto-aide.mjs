// Petits outils de lecture pour le changement de contrat (aucune transaction ici).
//   node outils/loto-aide.mjs info <contrat>      → état utile en JSON
//   node outils/loto-aide.mjs hex <ase1…>         → adresse 0x
//   node outils/loto-aide.mjs cfg <contrat>       → réglages (getConfig) en JSON
//   node outils/loto-aide.mjs prelevement <contrat> → prélèvement maison (wei) du dernier tirage terminé
//   node outils/loto-aide.mjs attendre <contrat> <deploye|initialise|pause> → attend que la chaîne le confirme
import { toHex } from '../site/js/lotomath.js';
const RPC = (process.env.RPC_URL || 'https://testnet.asentum.com').replace(/\/$/, '');
const [cmd, a, b] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function view(contract, method, args = []) {
  // le serveur du testnet répond parfois une page d'erreur (HTML) : on réessaie jusqu'à 6 fois
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RPC + '/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract, method, args }) });
      return JSON.parse(await r.text());
    } catch (e) { if (i >= 5) throw e; await sleep(5000); }
  }
}
if (cmd === 'hex') console.log(toHex(a));
else if (cmd === 'cfg') console.log(JSON.stringify((await view(a, 'getConfig')).returnValue));
else if (cmd === 'heures') { const i = (await view(a, 'info')).returnValue; console.log(Math.floor((Number(i.drawTs) - Number(i.now)) / 3600000)); }
else if (cmd === 'etat') console.log(JSON.stringify((await view(a, 'getState')).returnValue));
else if (cmd === 'info') {
  const c = (await view(a, 'getConfig')).returnValue, s = (await view(a, 'getState')).returnValue;
  const r = (await view(a, 'getRound', [s.cur])).returnValue;
  console.log(JSON.stringify({ admin: c.admin, payOwner: c.payOwner, payCollab: c.payCollab, collabAdmin: c.collabAdmin, paused: c.paused,
    tipO: s.tipO, tipC: s.tipC, owed: s.owed, jackpot: s.jackpot, enAttente: s.cur - s.next, cur: s.cur, grillesTourEnCours: r.grids, roundMaxn: r.maxn }));
} else if (cmd === 'tombola') {
  // tombola : tour en cours (tickets, tirage) et dernier tirage terminé
  const s = (await view(a, 'getState')).returnValue, r = (await view(a, 'getRound', [s.cur])).returnValue;
  const p = s.cur > 1 ? (await view(a, 'getRound', [s.cur - 1])).returnValue : null;
  const now = (await view(a, 'info')).returnValue.now;
  console.log(JSON.stringify({ now, cur: s.cur, next: s.next, tickets: r.tickets, drawTs: r.drawTs, lastDone: p && p.status === 'done' ? p.drawTs : 0, owed: s.owed }));
} else if (cmd === 'prelevement') {
  // prélèvement maison (wei) du dernier tirage terminé (0 s'il n'y en a pas eu)
  const s = (await view(a, 'getState')).returnValue;
  let out = '0';
  for (let id = s.next - 1; id >= 1 && id >= s.next - 3; id--) { const r = (await view(a, 'getRound', [id])).returnValue; if (r && r.status === 'done') { out = r.skim || '0'; break; } }
  console.log(out);
} else if (cmd === 'attendre') {
  for (let i = 0; i < 60; i++) {
    const v = await view(a, 'getConfig').catch(() => ({}));
    if (b === 'deploye' && v.ok) { console.log('ok'); process.exit(0); }
    if (b === 'initialise' && v.ok && v.returnValue) { console.log('ok'); process.exit(0); }
    if (b === 'pause' && v.ok && v.returnValue && v.returnValue.paused) { console.log('ok'); process.exit(0); }
    await sleep(10000);
  }
  console.log('pas encore confirmé après 10 min'); process.exit(1);
} else console.log('usage : info <contrat> | hex <ase1…> | attendre <contrat> deploye|initialise|pause');
