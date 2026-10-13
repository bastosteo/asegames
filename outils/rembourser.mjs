// Lecture seule : qui a joué le tirage / la Raffle / la carte EN COURS des anciens contrats,
// et combien lui rembourser (le prix payé, en entier). Aucune transaction ici.
//   node outils/rembourser.mjs verifier <loto> <raffle> <tresor>   → "OK" ou "ATTENTE<TAB>raison"
//   node outils/rembourser.mjs liste    <loto> <raffle> <tresor>   → une ligne par wallet :
//        adresse ase1<TAB>montant en ASE<TAB>détail
// (un contrat vide "-" est ignoré ; TREASURE_SEED = graine de l'ancienne carte, pour la vérification)
import { toHex, toAse1 } from '../site/js/lotomath.js';
const RPC = (process.env.RPC_URL || 'https://testnet.asentum.com').replace(/\/$/, '');
async function view(contract, method, args = []) {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch(RPC + '/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract: toHex(contract), method, args }) });
      const j = JSON.parse(await r.text());
      if (!j.ok) throw new Error(`${method} : ${j.reason || 'lecture impossible'}`);
      return j.returnValue;
    } catch (e) { if (k >= 5) throw e; await new Promise((r) => setTimeout(r, 2000 * (k + 1))); }
  }
}
async function all(c, method, id, n) {
  const out = [];
  for (let k = 0; k < n; k += 400) out.push(...(await view(c, method, [id, k, Math.min(400, n - k)])));
  return out;
}
const asStr = (w) => { const s = BigInt(w).toString().padStart(19, '0'); const t = (s.slice(0, -18) + '.' + s.slice(-18)).replace(/\.?0+$/, ''); return t; };
const [cmd, loto, raffle, tresor] = process.argv.slice(2);
const ok = (c) => c && c !== '-';

if (cmd === 'verifier') {
  if (ok(loto)) {
    const st = await view(loto, 'getState'), i = await view(loto, 'info');
    if (st.next < st.cur) { console.log(`ATTENTE\tle tirage n°${st.next} du Loto est en cours (fermé, pas encore tiré)`); process.exit(0); }
    if (i.status === 'closing') { console.log('ATTENTE\tles ventes du Loto sont fermées : le tirage de ce soir est en cours'); process.exit(0); }
  }
  if (ok(raffle)) {
    const st = await view(raffle, 'getState'), i = await view(raffle, 'info');
    if (st.next < st.cur || i.status === 'closing') { console.log('ATTENTE\tle tirage de la Raffle est en cours'); process.exit(0); }
  }
  if (ok(tresor) && process.env.TREASURE_SEED) {
    const st = await view(tresor, 'getState');
    const g = st.cur ? await view(tresor, 'getGrid', [st.cur]) : null;
    if (g && g.status === 'open' && g.digs) {
      const { board } = await import('../functions/_lib/board.mjs');
      if ((await view(tresor, 'cellOf', [g.id, board(process.env.TREASURE_SEED, g.id).treasure])) >= 0) { console.log(`ATTENTE\tle trésor de la carte n°${g.id} vient d'être trouvé : le croupier paie le gagnant`); process.exit(0); }
    }
  }
  console.log('OK');
} else if (cmd === 'liste') {
  const due = new Map();
  const add = (b, wei, what) => { const k = b.toLowerCase(); const e = due.get(k) || { w: 0n, d: [] }; e.w += wei; e.d.push(what); due.set(k, e); };
  if (ok(loto)) {
    // tirages pas encore tirés (en cours, ou fermés sans tirage depuis la pause)
    const st = await view(loto, 'getState');
    for (let id = st.next; id <= st.cur + 1; id++) {
      const r = await view(loto, 'getRound', [id]);
      if (r && r.buys && (r.status === 'open' || r.status === 'closed')) for (const p of await all(loto, 'getPurchases', r.id, r.buys)) add(p.b, BigInt(r.price) * BigInt(p.g.length), `Loto #${r.id} : ${p.g.length} grille(s)`);
    }
  }
  if (ok(raffle)) {
    const st = await view(raffle, 'getState');
    for (let id = st.next; id <= st.cur + 1; id++) {
      const r = await view(raffle, 'getRound', [id]);
      if (r && r.buys && (r.status === 'open' || r.status === 'closed')) for (const p of await all(raffle, 'getPurchases', r.id, r.buys)) add(p.b, BigInt(r.price) * BigInt(p.n), `Raffle #${r.id} : ${p.n} ticket(s)`);
    }
  }
  if (ok(tresor)) {
    const st = await view(tresor, 'getState');
    const g = st.cur ? await view(tresor, 'getGrid', [st.cur]) : null;
    if (g && g.status === 'open' && g.digs) for (const d of await all(tresor, 'getDigs', g.id, g.digs)) add(d.b, BigInt(g.price), `Treasure carte #${g.id} : 1 fouille`);
  }
  for (const [b, e] of [...due.entries()].sort()) {
    const n = new Map(); for (const x of e.d) n.set(x, (n.get(x) || 0) + 1);
    const detail = [...n.entries()].map(([x, k]) => (k > 1 && x.includes('fouille') ? x.replace('1 fouille', k + ' fouilles') : k > 1 ? `${x} ×${k}` : x)).join(' ; ');
    console.log(`${toAse1(b)}\t${asStr(e.w)}\t${detail}`);
  }
} else console.log('usage : verifier|liste <loto> <raffle> <tresor>');
