// MODE DÉMO : le vrai contrat tourne dans le navigateur sur une fausse
// chaîne. Rien n'est envoyé sur Asentum, aucun ASE n'est dépensé.
// Un "croupier démo" fait les tirages automatiquement. Le bouton
// « Aller au tirage » avance l'horloge jusqu'à la fermeture des ventes.
import { Chain } from './vm-sim.js';
import * as L from '../lotomath.js';

const DAY = 86400000;
export const DEMO_ME = '0x' + '5'.repeat(40);         // ton wallet démo (= admin, pour voir le panneau)
const OWNER_PAY = '0x' + 'b'.repeat(40), COLLAB = '0x' + 'c'.repeat(40);
const ASE = 10n ** 18n;

function makeChain(n) {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  const c = [[...b].map((x) => x.toString(16).padStart(2, '0')).join('')];
  for (let i = 0; i < n; i++) c.push(L.sha256Hex(c[c.length - 1]));
  return c;
}

export async function startDemo(contractUrl) {
  const source = await fetch(contractUrl).then((r) => r.text());
  let offset = 0;                                      // avance de l'horloge démo
  const clock = () => Date.now() + offset;
  const chain = new Chain({ startTimestampMs: clock() - 6 * DAY, blockTimeMs: 1000 });
  const players = Array.from({ length: 40 }, (_, i) => '0x' + (0xabc000 + i).toString(16).padStart(40, '0'));
  for (const a of [DEMO_ME, COLLAB, ...players]) chain.fund(a, 100000n * ASE);
  chain.fund(DEMO_ME, 0n);
  const c = chain.deploy(source, DEMO_ME);
  const chO = makeChain(400), chC = makeChain(400);
  c.call(DEMO_ME, 'init', [OWNER_PAY, COLLAB, COLLAB, chO.at(-1), chC.at(-1)]);

  const receipts = new Map();
  let txn = 0;
  const pre = (ch, tip) => ch[ch.indexOf(tip) - 1];

  // Croupier démo : ferme, révèle, compte, paie.
  function croupier() {
    const info = c.view('info');
    if (info.status === 'closing') c.call(COLLAB, 'poke');
    for (let guard = 0; guard < 20; guard++) {
      const s = c.view('getState');
      if (s.next >= s.cur) break;
      const r = c.view('getRound', [s.next]);
      if (r.status === 'closed' && !r.sO) c.call(COLLAB, 'reveal', ['owner', r.id, pre(chO, s.tipO)]);
      else if (r.status === 'closed' && !r.sC) c.call(COLLAB, 'reveal', ['collab', r.id, pre(chC, s.tipC)]);
      else if (r.status === 'tally') c.call(COLLAB, 'tally', [r.id, 400]);
      else break;
    }
    const s = c.view('getState');
    // Paiement automatique des tours terminés, sauf le dernier : ses gains
    // restent « à réclamer » pour que tu puisses essayer le bouton.
    for (let id = Math.max(1, s.next - 6); id < s.next - 1; id++) {
      const r = c.view('getRound', [id]);
      if (r.status !== 'done') continue;
      let i = 0;
      while (i < r.buys) {
        const res = c.call(COLLAB, 'settle', [id, i, 400]);
        if (!res.success) break;
        i = res.returnValue.next;
      }
    }
  }
  function randomPlayers(n) {
    for (let k = 0; k < n; k++) {
      const p = players[Math.floor(Math.random() * players.length)];
      const g = Array.from({ length: 1 + Math.floor(Math.random() * 6) }, () => L.flashGrid());
      c.call(p, 'buy', [g, L.randomSeedHex()], 2n * ASE * BigInt(g.length));
      chain.mine(Math.floor(Math.random() * 600));
    }
  }

  // Historique : 5 tirages passés
  for (let d = 0; d < 6; d++) {
    const cur = c.view('getState').cur;
    const r = c.view('getRound', [cur]);
    if (r.closeTs > clock()) break;
    randomPlayers(20 + Math.floor(Math.random() * 40));
    if (d >= 3) c.call(DEMO_ME, 'buy', [[L.flashGrid(), L.flashGrid()], L.randomSeedHex()], 4n * ASE);
    chain.mineUntil(r.closeTs); chain.mine(2);
    croupier();
  }
  chain.mineUntil(clock());
  randomPlayers(15);
  chain.mineUntil(clock());

  setInterval(() => { chain.mineUntil(clock()); croupier(); }, 1000);

  const api = {
    demo: true,
    rpc: {
      url: 'démo (dans ton navigateur)',
      view: async (_c, m, a = []) => JSON.parse(JSON.stringify(c.view(m, a))),
      balance: async (a) => chain.balanceOf(L.toHex(a)),
      receipt: async (h) => receipts.get(h) || null,
      waitReceipt: async (h) => { await new Promise((ok) => setTimeout(ok, 900)); return receipts.get(h); },
      logs: async () => [],
    },
    wallet: {
      kind: 'demo', address: DEMO_ME,
      connect: async () => DEMO_ME, restore: async () => DEMO_ME, disconnect: async () => {},
      call: async (_c, m, a, v = 0n) => {
        await new Promise((ok) => setTimeout(ok, 500));
        const r = c.call(DEMO_ME, m, a, BigInt(v));
        const hash = '0xdemo' + (txn++).toString(16).padStart(60, '0');
        receipts.set(hash, { txHash: hash, blockNumber: String(chain.blockNumber), success: r.success, error: r.success ? undefined : 'contract call failed: ' + r.error, returnValue: r.returnValue });
        return hash;
      },
    },
    contractAddress: c.address,
    goToDraw: () => { const i = c.view('info'); offset += Math.max(0, Number(i.closeTs) - clock() + 2000); chain.mineUntil(clock()); croupier(); },
  };
  return api;
}
