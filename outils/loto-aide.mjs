// Petits outils de lecture pour le changement de contrat (aucune transaction ici).
//   node outils/loto-aide.mjs info <contrat>      → état utile en JSON
//   node outils/loto-aide.mjs hex <ase1…>         → adresse 0x
//   node outils/loto-aide.mjs attendre <contrat> <deploye|initialise|pause> → attend que la chaîne le confirme
import { toHex } from '../site/js/lotomath.js';
const RPC = (process.env.RPC_URL || 'https://testnet.asentum.com').replace(/\/$/, '');
const [cmd, a, b] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function view(contract, method, args = []) {
  const r = await fetch(RPC + '/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract, method, args }) });
  return r.json();
}
if (cmd === 'hex') console.log(toHex(a));
else if (cmd === 'info') {
  const c = (await view(a, 'getConfig')).returnValue, s = (await view(a, 'getState')).returnValue;
  const r = (await view(a, 'getRound', [s.cur])).returnValue;
  console.log(JSON.stringify({ admin: c.admin, payOwner: c.payOwner, payCollab: c.payCollab, collabAdmin: c.collabAdmin, paused: c.paused,
    tipO: s.tipO, tipC: s.tipC, owed: s.owed, jackpot: s.jackpot, enAttente: s.cur - s.next, cur: s.cur, grillesTourEnCours: r.grids }));
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
