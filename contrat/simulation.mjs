// Simulation de nombreux tirages : node contrat/simulation.mjs [nbTours]
// Vérifie à chaque tour, au wei près :
//   ventes totales = commissions + gains versés + gains à verser
//                  + remboursements + jackpot reporté + ventes pas encore tirées
// et que le solde réel du contrat est égal à ce qu'il doit détenir.
import { readFileSync } from 'node:fs';
import { Chain } from '../sim/vm-sim.mjs';
import * as ref from './ref.mjs';

const ROUNDS = Number(process.argv[2] || 365);
const SRC = readFileSync(new URL('./loto.js', import.meta.url), 'utf8');
const ASE = 10n ** 18n, PRICE = 2n * ASE;
const fmt = (w) => (Number(w / 10n ** 14n) / 10000).toFixed(4);

// Générateur pseudo-aléatoire reproductible
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const chain = new Chain({ startTimestampMs: Date.UTC(2026, 9, 10, 12), blockTimeMs: 8000 });
const ADMIN = '0x' + 'a'.repeat(40), OWNER = '0x' + 'b'.repeat(40), COLLAB = '0x' + 'c'.repeat(40);
const DROP = '0x' + 'f'.repeat(40);   // contrat ASE Airdrop (cagnotte)
const players = Array.from({ length: 300 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
for (const a of [ADMIN, COLLAB, ...players]) chain.fund(a, 10n ** 9n * ASE);
const c = chain.deploy(SRC, ADMIN);
const chO = ref.makeChain(ROUNDS + 50), chC = ref.makeChain(ROUNDS + 50);
let r = c.call(ADMIN, 'init', [OWNER, COLLAB, COLLAB, chO.at(-1), chC.at(-1), DROP]);
if (!r.success) throw new Error(r.error);

const must = (x, what) => { if (!x.success) throw new Error(what + ': ' + x.error); return x; };
let totalSales = 0n, cancelled = 0, jackpots = 0, maxJackpot = 0n, maxGas = 0;
const won = [0n, 0n, 0n], winners = [0, 0, 0];
const ownerStart = chain.balanceOf(OWNER), collabStart = chain.balanceOf(COLLAB);
let collabGasSpent = 0n;

for (let k = 0; k < ROUNDS; k++) {
  const id = c.view('getState').cur;
  const round = c.view('getRound', [id]);
  // Entre 0 et ~300 grilles ce jour-là (parfois 0)
  const nPlayers = rnd() < 0.05 ? 0 : 5 + Math.floor(rnd() * 60);
  for (let p = 0; p < nPlayers; p++) {
    const n = 1 + Math.floor(rnd() * 8);
    const grids = Array.from({ length: n }, () => ref.randomGrid(rnd));
    const x = must(c.call(players[Math.floor(rnd() * players.length)], 'buy', [grids, ''], PRICE * BigInt(n)), 'buy');
    maxGas = Math.max(maxGas, x.gas);
    totalSales += PRICE * BigInt(n);
    chain.mine(Math.floor(rnd() * 30));
  }
  chain.mineUntil(round.closeTs); chain.mine(1);
  must(c.call(players[0], 'poke'), 'poke');
  const rd = c.view('getRound', [id]);
  if (rd.status === 'closed') {
    {
      must(c.call(ADMIN, 'reveal', ['owner', id, ref.preimageOf(chO, c.view('getState').tipO)]), 'revealO');
      // 3 % des soirs : le collaborateur est en retard de 5 h → le tirage attend, rien n'est annulé
      if (rnd() < 0.03) { chain.mineUntil(rd.closeTs + 5 * 3600000); cancelled++; }
      must(c.call(COLLAB, 'reveal', ['collab', id, ref.preimageOf(chC, c.view('getState').tipC)]), 'revealC');
      let done = false;
      while (!done) { const x = must(c.call(ADMIN, 'tally', [id, 300]), 'tally'); maxGas = Math.max(maxGas, x.gas); done = x.returnValue.done; }
      const f = c.view('getRound', [id]);
      for (let q = 0; q < 3; q++) { winners[q] += f.cnt[q]; won[q] += BigInt(f.cnt[q]) * BigInt(f.per[q]); }
      if (f.cnt[2] > 0) { jackpots++; const jp = BigInt(f.per[2]) * BigInt(f.cnt[2]); if (jp > maxJackpot) maxJackpot = jp; }
      // Vérifie les gains contre la référence et l'ordre 5 > 4 > 3
      const ex = ref.payouts(f.sales, f.price, f.jackpotIn, f.cnt);
      if (JSON.stringify(f.per) !== JSON.stringify(ex.per.map(String))) throw new Error(`Tour ${id} : gains ≠ référence`);
      const g = f.per.map(BigInt);
      if (f.cnt[1] && f.cnt[0] && !(g[1] > g[0])) throw new Error(`Tour ${id} : 4 bons ≤ 3 bons`);
      if (f.cnt[2] && f.cnt[1] && !(g[2] > g[1])) throw new Error(`Tour ${id} : 5 bons ≤ 4 bons`);
      // Paiement automatique, mais ~10 % des gagnants règlent eux-mêmes leur achat avant
      const list = c.view('getPurchases', [id, 0, Math.min(400, f.buys)]);
      for (const p of list) if (p.prize !== '0' && rnd() < 0.1) must(c.call(p.b, 'settle', [id, p.idx, 1]), 'settle soi-même');
      let i = 0;
      while (i < f.buys) { const x = must(c.call(ADMIN, 'settle', [id, i, 100]), 'pay'); maxGas = Math.max(maxGas, x.gas); i = x.returnValue.next; }
    }
  }
  // --- Vérification de conservation, au wei près ---
  const s = c.view('getState');
  let pending = 0n;
  for (let j = s.next; j <= s.cur; j++) { const x = c.view('getRound', [j]); if (['open', 'closed', 'tally'].includes(x.status)) pending += BigInt(x.sales) - BigInt(x.commission); }
  const T = s.tot;
  const lhs = BigInt(T.sales);
  const rhs = BigInt(T.commission) + BigInt(T.prizes) + BigInt(s.owed) + BigInt(T.refunds) + BigInt(s.jackpot) + pending;
  if (lhs !== rhs) throw new Error(`Tour ${id} : conservation violée ${lhs} ≠ ${rhs}`);
  const bal = chain.balanceOf(c.address);
  if (bal !== BigInt(s.jackpot) + BigInt(s.owed) + pending) throw new Error(`Tour ${id} : solde ${bal} ≠ attendu`);
  if (BigInt(T.sales) !== totalSales) throw new Error('ventes mal comptées');
}

const s = c.view('getState');
const T = s.tot;
const commission = BigInt(T.commission);
const toOwner = chain.balanceOf(OWNER) - ownerStart;
const toCollab = chain.balanceOf(COLLAB) - collabStart;
console.log(`Simulation de ${ROUNDS} tirages quotidiens (${T.grids} grilles, ${T.buys} achats)`);
console.log(`  Ventes totales           : ${fmt(BigInt(T.sales))} ASE`);
const drawnSales = BigInt(T.sales);
console.log(`  Commission               : ${fmt(commission)} ASE = ${(Number(commission * 100000n / drawnSales) / 1000).toFixed(3)} % des ventes (prélevée à chaque achat)`);
console.log(`    → owner (75 % de la moitié) : ${fmt(toOwner)} ASE   → collaborateur (25 %) : ${fmt(toCollab)} ASE`);
const toDrop = chain.balanceOf(DROP);
console.log(`    → Airdrop (50 %)       : ${fmt(toDrop)} ASE`);
console.log(`    → partage exact        : ${toOwner + toCollab + toDrop === commission ? 'oui, owner + collab + Airdrop = commission au wei près' : 'ÉCART'}`);
console.log(`  Gains versés             : ${fmt(BigInt(T.prizes))} ASE   (à verser : ${fmt(BigInt(s.owed))})`);
console.log(`  Remboursements           : aucun (${cancelled} tirages faits en retard, aucun annulé)`);
console.log(`  Jackpot reporté actuel   : ${fmt(BigInt(s.jackpot))} ASE`);
console.log(`  Gagnants 3 bons          : ${winners[0]} (moy. ${winners[0] ? fmt(won[0] / BigInt(winners[0])) : '-'} ASE)`);
console.log(`  Gagnants 4 bons          : ${winners[1]} (moy. ${winners[1] ? fmt(won[1] / BigInt(winners[1])) : '-'} ASE)`);
console.log(`  Jackpots tombés          : ${jackpots} (plus gros : ${fmt(maxJackpot)} ASE)`);
console.log(`  Gas max d'une transaction: ${maxGas} (limite 1 000 000)`);
console.log(`  Conservation de l'argent : vérifiée à chaque tour, au wei près ✓`);
console.log(`  Solde final du contrat   : ${fmt(chain.balanceOf(c.address))} ASE = jackpot + gains à verser + ventes en cours ✓`);
