// MODE DÉMO : le vrai contrat de la tombola tourne dans le navigateur sur une
// fausse chaîne. Rien n'est envoyé sur Asentum. Un « croupier démo » fait les
// tirages ; « Skip to Sunday's draw » avance l'horloge jusqu'à la fermeture.
import { Chain } from '../../loto/js/demo/vm-sim.js';
import * as L from '../../loto/js/lotomath.js';

const DAY = 86400000;
export const DEMO_ME = '0x' + '5'.repeat(40);
const OWNER_PAY = '0x' + 'b'.repeat(40), COLLAB = '0x' + 'c'.repeat(40);
const DROP = '0x' + 'f'.repeat(40);   // contrat ASE Airdrop (cagnotte)
const ASE = 10n ** 18n;

function makeChain(n) {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  const c = [[...b].map((x) => x.toString(16).padStart(2, '0')).join('')];
  for (let i = 0; i < n; i++) c.push(L.sha256Hex(c[c.length - 1]));
  return c;
}

export async function startDemo(contractUrl) {
  const source = await fetch(contractUrl).then((r) => r.text());
  let offset = 0;
  const clock = () => Date.now() + offset;
  const chain = new Chain({ startTimestampMs: clock() - 22 * DAY, blockTimeMs: 1000 });
  const players = Array.from({ length: 60 }, (_, i) => '0x' + (0xbee000 + i).toString(16).padStart(40, '0'));
  for (const a of [DEMO_ME, COLLAB, ...players]) chain.fund(a, 100000n * ASE);
  const c = chain.deploy(source, DEMO_ME);
  const chO = makeChain(200), chC = makeChain(200);
  c.call(DEMO_ME, 'init', [OWNER_PAY, COLLAB, COLLAB, chO.at(-1), chC.at(-1), DROP]);
  const receipts = new Map();
  let txn = 0;
  const pre = (ch, tip) => ch[ch.indexOf(tip) - 1];
  const price = () => BigInt(c.view('info').price);

  function croupier() {
    if (c.view('info').status === 'closing') c.call(COLLAB, 'poke');
    for (let guard = 0; guard < 10; guard++) {
      const s = c.view('getState');
      if (s.next >= s.cur) break;
      const r = c.view('getRound', [s.next]);
      if (r.status === 'closed' && !r.sO) c.call(COLLAB, 'reveal', ['owner', r.id, pre(chO, s.tipO)]);
      else if (r.status === 'closed' && !r.sC) c.call(COLLAB, 'reveal', ['collab', r.id, pre(chC, s.tipC)]);
      else break;
    }
  }
  function randomPlayers(n) {
    for (let k = 0; k < n; k++) {
      const p = players[Math.floor(Math.random() * players.length)];
      const cur = c.view('getState').cur;
      const have = c.view('getWallet', [cur, p]);
      if (have >= 10) continue;
      const q = 1 + Math.floor(Math.random() * Math.min(5, 10 - have));
      c.call(p, 'buy', [q, L.randomSeedHex()], price() * BigInt(q));
      chain.mine(Math.floor(Math.random() * 3000));
    }
  }
  // Historique : 3 tombolas passées (tu as joué aux 2 dernières)
  for (let w = 0; w < 4; w++) {
    const cur = c.view('getState').cur;
    const r = c.view('getRound', [cur]);
    if (r.closeTs > clock()) break;
    randomPlayers(25 + Math.floor(Math.random() * 25));
    if (w >= 1) c.call(DEMO_ME, 'buy', [3, L.randomSeedHex()], price() * 3n);
    chain.mineUntil(r.closeTs); chain.mine(2);
    croupier();
  }
  chain.mineUntil(clock());
  randomPlayers(12);
  chain.mineUntil(clock());
  setInterval(() => { chain.mineUntil(clock()); croupier(); }, 1000);

  return {
    demo: true,
    rpc: {
      url: 'demo (in your browser)',
      view: async (_c, m, a = []) => JSON.parse(JSON.stringify(c.view(m, a))),
      balance: async (a) => chain.balanceOf(L.toHex(a)),
      receipt: async (h) => receipts.get(h) || null,
      waitReceipt: async (h) => { await new Promise((ok) => setTimeout(ok, 1200)); return receipts.get(h); },
    },
    wallet: {
      kind: 'demo', address: DEMO_ME,
      connect: async () => DEMO_ME, restore: async () => DEMO_ME, disconnect: async () => {},
      call: async (_c, m, a, v = 0n) => {
        await new Promise((ok) => setTimeout(ok, 400));
        const r = c.call(DEMO_ME, m, a, BigInt(v));
        const hash = '0xdemo' + (txn++).toString(16).padStart(60, '0');
        receipts.set(hash, { txHash: hash, blockNumber: String(chain.blockNumber), success: r.success, error: r.success ? undefined : 'contract call failed: ' + r.error, returnValue: r.returnValue });
        return hash;
      },
    },
    contractAddress: c.address,
    goToDraw: () => {
      // Assure au moins 3 participants, puis avance jusqu'à la fermeture.
      if (c.view('info').wallets < 3) randomPlayers(6);
      const i = c.view('info'); offset += Math.max(0, Number(i.closeTs) - clock() + 2000); chain.mineUntil(clock()); croupier();
    },
  };
}
