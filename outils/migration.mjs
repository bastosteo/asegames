// Lecture seule : ce qu'il reste à faire sur un ANCIEN contrat (loto ou tombola) avant de le
// remplacer. Aucune transaction ici : le script bash demande (o/n) puis envoie chaque appel.
//   node outils/migration.mjs plan <contrat> loto|raffle
//        → une ligne par appel à faire : méthode<TAB>arguments JSON<TAB>description en français
//          ou "ATTENTE<TAB><raison>" si un tirage est en cours (les croupiers doivent finir)
//   node outils/migration.mjs attendre <contrat> loto|raffle <méthode> <arguments JSON>
//        → attend (10 min max) que cet appel ait pris effet sur la chaîne
import { toHex } from '../site/js/lotomath.js';
const RPC = (process.env.RPC_URL || 'https://testnet.asentum.com').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ase = (w) => (Number(BigInt(w) / 10n ** 14n) / 10000).toLocaleString('fr-FR');
async function view(contract, method, args = []) {
  const r = await fetch(RPC + '/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract: toHex(contract), method, args }) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method} : ${j.reason || 'lecture impossible'}`);
  return j.returnValue;
}
async function purchases(c, r) {
  const out = [];
  for (let k = 0; k < r.buys; k += 400) out.push(...(await view(c, 'getPurchases', [r.id, k, 400])));
  return out;
}

export async function plan(c, game) {
  const cfg = await view(c, 'getConfig'), st = await view(c, 'getState');
  const todo = [];
  if (!cfg.paused) todo.push(['setPaused', [true], 'Mettre l\'ancien contrat en pause (plus aucun achat)']);
  for (let id = st.next; id < st.cur; id++) {
    const r = await view(c, 'getRound', [id]);
    if (['closed', 'tally'].includes(r.status)) return [['ATTENTE', `le tirage n°${id} de l'ancien contrat n'est pas fini (statut ${r.status}) : les croupiers s'en occupent`]];
  }
  const cur = await view(c, 'getRound', [st.cur]);
  const count = game === 'loto' ? cur.grids : cur.tickets;
  if (cur.status === 'open' && count > 0) {
    if (cur.sO || cur.sC) return [['ATTENTE', `le tirage n°${cur.id} est en cours`]];
    todo.push(['emergencyCancel', [cur.id], `Annuler le tirage n°${cur.id} en cours (${count} ${game === 'loto' ? 'grilles' : 'tickets'}) : les joueurs sont remboursés à 100 %`]);
  }
  // Gains non réclamés et remboursements en attente (40 derniers tirages)
  for (let id = Math.max(1, st.cur - 40); id <= st.cur; id++) {
    const r = await view(c, 'getRound', [id]);
    if (!r || !r.buys) continue;
    if (game === 'raffle' && r.status === 'done') {
      r.claimed.forEach((done, k) => { if (!done) todo.push(['claim', [id, k], `Envoyer au gagnant n°${k + 1} de la tombola n°${id} son prix (${ase(r.prizes[k])} ASE)`]); });
      continue;
    }
    if (r.status !== 'done' && r.status !== 'cancelled') continue;
    const list = await purchases(c, r);
    const pend = list.filter((p) => !p.paid && (r.status === 'cancelled' || (p.prize && p.prize !== '0')));
    if (!pend.length) continue;
    const what = r.status === 'cancelled' ? 'Rembourser les joueurs' : 'Envoyer leurs gains aux gagnants';
    todo.push(['settle', [id, pend[0].idx, 400], `${what} du tirage n°${id} (${pend.length} achat(s))`]);
  }
  return todo;
}

const [cmd, c, game, m, a] = process.argv.slice(2);
if (cmd === 'plan') {
  for (const [method, args, desc] of await plan(c, game)) console.log(method === 'ATTENTE' ? `ATTENTE\t${args}` : `${method}\t${JSON.stringify(args)}\t${desc}`);
} else if (cmd === 'attendre') {
  for (let i = 0; i < 60; i++) {
    await sleep(10000);
    const p = await plan(c, game).catch(() => null);
    if (p && !p.some(([mm, aa]) => mm === m && JSON.stringify(aa) === a)) { console.log('ok'); process.exit(0); }
  }
  console.log('pas encore confirmé après 10 min'); process.exit(1);
} else if (cmd) {
  console.log('usage : plan <contrat> loto|raffle | attendre <contrat> loto|raffle <méthode> <args>');
}
