// MODE DÉMO : le vrai contrat ASE Treasure tourne dans le navigateur sur une fausse
// chaîne, avec une grille secrète tirée au hasard. Rien n'est envoyé sur Asentum.
// Un « croupier démo » ouvre les grilles et d'autres joueurs fouillent de temps en temps.
import { Chain } from '../../loto/js/demo/vm-sim.js';
import * as L from '../../loto/js/lotomath.js';
import { board, CELLS } from './board.mjs';

export const DEMO_ME = '0x' + '5'.repeat(40);
const OWN = '0x' + 'b'.repeat(40), COL = '0x' + 'c'.repeat(40), DROP = '0x' + 'f'.repeat(40);
const ASE = 10n ** 18n;

export async function startDemo(contractUrl) {
  const source = await fetch(contractUrl).then((r) => r.text());
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  const seed = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const chain = new Chain({ startTimestampMs: Date.now() - 3 * 86400000, blockTimeMs: 1000 });
  const players = Array.from({ length: 40 }, (_, i) => '0x' + (0xd16000 + i).toString(16).padStart(40, '0'));
  for (const a of [DEMO_ME, ...players]) chain.fund(a, 100000n * ASE);
  const c = chain.deploy(source, DEMO_ME);
  c.call(DEMO_ME, 'init', [DEMO_ME, OWN, COL, DROP]);
  const boards = new Map();
  const bd = (id) => { if (!boards.has(id)) boards.set(id, board(seed, id)); return boards.get(id); };
  const price = () => BigInt(c.view('getGrid', [c.view('getState').cur]).price);
  function croupier() {
    const s = c.view('getState');
    const g = s.cur ? c.view('getGrid', [s.cur]) : null;
    if (!g || g.status !== 'open') { c.call(DEMO_ME, 'openGrid', [s.cur + 1, bd(s.cur + 1).root]); return; }
    const t = bd(g.id).treasure;
    if (c.view('cellOf', [g.id, t]) >= 0) { const a = bd(g.id).answer(t); c.call(DEMO_ME, 'claim', [g.id, a.cell, a.salt, a.proof]); }
  }
  // Un autre joueur fouille une case encore libre (et pas le trésor, sauf malchance)
  function botDig(allowTreasure) {
    const s = c.view('getState'), g = c.view('getGrid', [s.cur]);
    if (!g || g.status !== 'open') return;
    const t = bd(g.id).treasure;
    for (let k = 0; k < 30; k++) {
      const cell = Math.floor(Math.random() * CELLS);
      if ((!allowTreasure && cell === t) || c.view('cellOf', [g.id, cell]) >= 0) continue;
      const p = players[Math.floor(Math.random() * players.length)];
      if (c.view('digsOf', [g.id, p]) >= 5) continue;
      c.call(p, 'dig', [g.id, cell], price());
      chain.mine(30);
      return;
    }
  }
  // Historique : 3 grilles terminées, puis une grille en cours avec quelques fouilles
  for (let k = 0; k < 3; k++) {
    croupier();
    const g = c.view('getGrid', [c.view('getState').cur]);
    for (let n = 0; n < 6 + Math.floor(Math.random() * 10); n++) botDig(false);
    const p = players[k];
    c.call(p, 'dig', [g.id, bd(g.id).treasure], price());
    chain.mine(200);
    croupier();
  }
  croupier();
  for (let n = 0; n < 5; n++) botDig(false);
  const receipts = new Map();
  let txn = 0;
  setInterval(() => { chain.mineUntil(Date.now()); croupier(); }, 1500);
  setInterval(() => botDig(Math.random() < 0.15), 20000);
  const answers = async (grid, cells) => {
    const g = c.view('getGrid', [grid]);
    const closed = g.status !== 'open', B = bd(grid);
    const ok = closed ? cells : cells.filter((x) => c.view('cellOf', [grid, x]) >= 0);
    return { grid, root: B.root, closed, answers: ok.map((x) => B.answer(x)), treasure: closed ? B.treasure : undefined };
  };
  return {
    demo: true, answers,
    rpc: {
      url: 'demo (in your browser)',
      view: async (_c, m, a = []) => JSON.parse(JSON.stringify(c.view(m, a))),
      balance: async (a) => chain.balanceOf(L.toHex(a)),
      receipt: async (h) => receipts.get(h) || null,
      waitReceipt: async (h) => { await new Promise((ok) => setTimeout(ok, 1500)); return receipts.get(h); },
    },
    wallet: {
      kind: 'demo', address: DEMO_ME,
      connect: async () => DEMO_ME, restore: async () => DEMO_ME, disconnect: async () => {},
      call: async (_c, m, a, v = 0n) => {
        await new Promise((ok) => setTimeout(ok, 400));
        chain.mine(1);
        const r = c.call(DEMO_ME, m, a, BigInt(v));
        const hash = '0xdemo' + (txn++).toString(16).padStart(60, '0');
        receipts.set(hash, { txHash: hash, blockNumber: String(chain.blockNumber), success: r.success, error: r.success ? undefined : 'contract call failed: ' + r.error, returnValue: r.returnValue });
        return hash;
      },
    },
    contractAddress: c.address,
  };
}
