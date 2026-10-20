// Tests automatisés de la tombola : node contrat/tombola.test.mjs
import { readFileSync } from 'node:fs';
import { Chain } from '../sim/vm-sim.mjs';
import * as ref from './ref.mjs';

const FILE = process.env.TOMBOLA_FILE || './tombola-v3.js';
const SRC = readFileSync(new URL(FILE, import.meta.url), 'utf8');
const ASE = 10n ** 18n, PRICE = 5n * ASE;
let ok = 0, ko = 0, section = '';
const t = (name, cond, extra = '') => { if (cond) ok++; else { ko++; console.log(`  ✗ [${section}] ${name}`, extra); } };
const sec = (n) => { section = n; console.log('•', n); };
const ADMIN = '0x' + 'a'.repeat(40), OWNER_PAY = '0x' + 'b'.repeat(40), COLLAB = '0x' + 'c'.repeat(40);
const DROP = '0x' + 'f'.repeat(40);   // contrat ASE Airdrop (cagnotte)
const P = Array.from({ length: 600 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));

function world({ start = Date.UTC(2026, 9, 10, 12, 0) } = {}) {
  const chain = new Chain({ startTimestampMs: start, blockTimeMs: 8000 });
  for (const a of [ADMIN, OWNER_PAY, COLLAB, ...P]) chain.fund(a, 100000n * ASE);
  const c = chain.deploy(SRC, ADMIN);
  const chO = ref.makeChain(100), chC = ref.makeChain(100);
  const r = c.call(ADMIN, 'init', [OWNER_PAY, COLLAB, COLLAB, chO[100], chC[100], DROP]);
  if (!r.success) throw new Error('init: ' + r.error);
  const w = {
    chain, c, chO, chC,
    st: () => c.view('getState'), round: (id) => c.view('getRound', [id]),
    buy: (who, n, seed = '') => c.call(who, 'buy', [n, seed], PRICE * BigInt(n)),
    close: (id) => { chain.mineUntil(w.round(id).closeTs); chain.mine(1); return c.call(P[599], 'poke'); },
    revealO: (id) => c.call(ADMIN, 'reveal', ['owner', id, ref.preimageOf(w.chO, w.st().tipO)]),
    revealC: (id) => c.call(COLLAB, 'reveal', ['collab', id, ref.preimageOf(w.chC, w.st().tipC)]),
    draw: (id) => { w.close(id); const a = w.revealO(id); if (!a.success) return a; return w.revealC(id); },
    purchases: (id) => c.view('getPurchases', [id, 0, 400]).map((p) => ({ b: p.b, n: p.n, first: p.first })),
    expectedBalance: () => {
      const s = w.st(); let pend = 0n;
      for (let id = s.next; id <= s.cur; id++) { const r = w.round(id); if (['open', 'closed'].includes(r.status)) pend += BigInt(r.carryIn) + BigInt(r.sales) - BigInt(r.commission); }
      return pend + BigInt(s.owed);
    },
  };
  return w;
}
const balanceOk = (w) => w.chain.balanceOf(w.c.address) === w.expectedBalance();

sec('Initialisation');
{
  const w = world();
  const cfg = w.c.view('getConfig');
  t('prix 5 ASE, 10 tickets par wallet', cfg.price === PRICE.toString() && cfg.maxPerWallet === 10);
  const r = w.round(1);
  t('tirage dimanche 11/10/2026 à 21:00 Paris', new Date(r.drawTs).toISOString() === '2026-10-11T19:00:00.000Z' && ref.parisHM(r.drawTs) === '21:00', new Date(r.drawTs).toISOString());
  t('fermeture à 20:50', ref.parisHM(r.closeTs) === '20:50');
  t('double init refusé', !w.c.call(ADMIN, 'init', [OWNER_PAY, COLLAB, COLLAB, w.chO[100], w.chC[100], DROP]).success);
  const w2 = world({ start: Date.UTC(2026, 9, 11, 19, 30) }); // dimanche 21h30 Paris → dimanche suivant
  t('ouvert après l\'heure du dimanche → dimanche suivant', new Date(w2.round(1).drawTs).toISOString() === '2026-10-18T19:00:00.000Z', new Date(w2.round(1).drawTs).toISOString());
}

sec('Achat de tickets');
{
  const w = world();
  let r = w.buy(P[0], 3, 'ab');
  t('3 tickets achetés', r.success && r.returnValue.first === 0 && r.returnValue.n === 3, r.error);
  t('événement Buy avec numéros de tickets', r.events.some((e) => e.name === 'Buy' && e.data.first === '0' && e.data.n === '3'));
  r = w.buy(P[1], 2);
  t('le 2e acheteur reçoit les tickets 3 et 4', r.success && r.returnValue.first === 3);
  t('7 tickets de plus pour le 1er (total 10) OK', w.buy(P[0], 7).success);
  const x = w.buy(P[0], 1);
  t('11e ticket refusé (10 max par wallet)', !x.success && /max 10/.test(x.error), x.error);
  t('compte par wallet', w.c.view('getWallet', [1, P[0]]) === 10 && w.c.view('getWallet', [1, P[1]]) === 2);
  t('0 ticket refusé', !w.c.call(P[2], 'buy', [0, ''], 0n).success);
  t('1,5 ticket refusé', !w.c.call(P[2], 'buy', [1.5, ''], PRICE).success);
  t('mauvais montant refusé', !w.c.call(P[2], 'buy', [2, ''], PRICE).success);
  t('graine non hexa refusée', !w.c.call(P[2], 'buy', [1, 'zz'], PRICE).success);
  const rd = w.round(1);
  t('12 tickets, 3 achats, 2 wallets, 60 ASE', rd.tickets === 12 && rd.buys === 3 && rd.wallets === 2 && rd.sales === (60n * ASE).toString());
  let d = ref.raffleInitialDigest(1);
  [[P[0], 3, 'ab'], [P[1], 2, ''], [P[0], 7, ''], [P[0], 0, '']].slice(0, 3).forEach(([b, n, s], i) => (d = ref.raffleNextDigest(d, b, n, s, i)));
  t('empreinte recalculable (référence indépendante)', rd.digest === d);
  t('solde cohérent', balanceOk(w));
}

sec('Commission versée à chaque achat');
{
  const w = world();
  const bO = w.chain.balanceOf(OWNER_PAY), bC = w.chain.balanceOf(COLLAB);
  w.buy(P[0], 2);
  const com = 2n * PRICE * 15n / 100n, drop = com / 2n, own = (com - drop) * 3n / 4n;
  t('Airdrop reçoit 7,5 % tout de suite', w.chain.balanceOf(DROP) === drop && w.round(1).airdrop === drop.toString());
  t('équipe 75 / 25 tout de suite', w.chain.balanceOf(OWNER_PAY) - bO === own && w.chain.balanceOf(COLLAB) - bC === com - drop - own);
  t('85 % restent dans le contrat', w.chain.balanceOf(w.c.address) === 2n * PRICE - com && balanceOk(w));
  t('achat horodaté', w.c.view('getPurchases', [1, 0, 1])[0].t > 0);
}

sec('Personne → reportée d\'une semaine');
{
  const w = world();
  const before = w.round(1);
  w.close(1);
  const r = w.round(1);
  t('toujours ouverte, même tombola', r.status === 'open' && w.st().cur === 1);
  t('tirage décalé d\'une semaine', r.drawTs - before.drawTs === 7 * 86400000 && r.weeks === 2);
}

sec('2 wallets → 2 gagnants, le 3e prix passe à la tombola suivante');
{
  const w = world();
  w.buy(P[0], 5); w.buy(P[1], 1);
  const d = w.draw(1);
  const r = w.round(1);
  t('tirage fait malgré 2 wallets', d.success && r.status === 'done' && r.win.length === 2, d.error);
  t('2 wallets différents', new Set(r.win.map((x) => x.b)).size === 2);
  t('gagnants = référence', JSON.stringify(r.win) === JSON.stringify(ref.raffleWinners(1, r.sO, r.sC, r.digest, w.purchases(1))));
  const pz = ref.rafflePrizes(r.sales, 0n, 2);
  t('prix 1 et 2 normaux, 3e = 0', JSON.stringify(r.prizes) === JSON.stringify(pz.prizes.map(String)) && r.prizes[2] === '0');
  t('le 3e prix est ajouté à la tombola 2', w.round(2).carryIn === pz.carry.toString() && r.carryOut === pz.carry.toString() && pz.carry > 0n);
  t('rang 3 non réclamable', !w.c.call(P[0], 'claim', [1, 2]).success);
  t('cagnotte affichée de la tombola 2 = report', w.c.view('info').pot === pz.carry.toString());
  t('solde cohérent', balanceOk(w));
  w.buy(P[3], 1);
  const d2 = w.draw(2), r2 = w.round(2);
  const pz2 = ref.rafflePrizes(r2.sales, pz.carry, 1);
  t('1 seul wallet → il gagne le 1er prix, 2e et 3e reportés', d2.success && r2.win.length === 1 && r2.prizes[0] === pz2.prizes[0].toString() && w.round(3).carryIn === pz2.carry.toString());
  t('solde cohérent (2)', balanceOk(w));
}

sec('Tirage : 3 wallets différents, référence indépendante');
{
  const w = world();
  for (let i = 0; i < 40; i++) w.buy(P[i], 1 + (i % 10));
  t('révélation avant fermeture refusée', !w.revealO(1).success);
  w.close(1);
  t('tombola 2 ouverte après la fermeture', w.st().cur === 2 && w.round(2).status === 'open');
  t('collab avant owner refusé', !w.revealC(1).success);
  t('owner : secret 2 maillons plus loin refusé (pas de choix possible)', !w.c.call(ADMIN, 'reveal', ['owner', 1, w.chO[98]]).success);
  t('owner révèle', w.revealO(1).success);
  t('collab : secret 2 maillons plus loin refusé', !w.c.call(COLLAB, 'reveal', ['collab', 1, w.chC[98]]).success);
  const rc = w.revealC(1);
  t('collab révèle → gagnants tirés (gas ' + rc.gas + ')', rc.success && rc.gas < 1_000_000, rc.error);
  const r = w.round(1);
  const exp = ref.raffleWinners(1, r.sO, r.sC, r.digest, w.purchases(1));
  t('gagnants = référence', JSON.stringify(r.win) === JSON.stringify(exp), JSON.stringify([r.win, exp]));
  t('3 wallets différents', new Set(r.win.map((x) => x.b)).size === 3);
  const pz = ref.rafflePrizes(r.sales);
  t('prix 50 / 30 / 20 % de 85 %', JSON.stringify(r.prizes) === JSON.stringify(pz.prizes.map(String)));
  t('1er = 42,5 % des ventes', BigInt(r.prizes[0]) * 200n === BigInt(r.sales) * 85n);
  t('commission totale = 15 %, dont 7,5 % Airdrop', r.commission === pz.commission.toString() && r.airdrop === pz.airdrop.toString() && w.chain.balanceOf(DROP) === pz.airdrop);
  t('dû aux gagnants = 85 % des ventes', w.st().owed === (BigInt(r.sales) - pz.commission).toString());
  t('solde cohérent', balanceOk(w));

  sec('Réclamer');
  const win = r.win;
  const b0 = w.chain.balanceOf(win[0].b);
  const cl = w.c.call(win[0].b, 'claim', [1, 0]);
  t('le 1er réclame son prix', cl.success && w.chain.balanceOf(win[0].b) - b0 === BigInt(r.prizes[0]), cl.error);
  t('événement Claimed', cl.events.some((e) => e.name === 'Claimed' && e.data.rank === '1'));
  t('double réclamation refusée', !w.c.call(win[0].b, 'claim', [1, 0]).success);
  const b2 = w.chain.balanceOf(win[2].b);
  t('un tiers déclenche, l\'argent va au gagnant', w.c.call(P[599], 'claim', [1, 2]).success && w.chain.balanceOf(win[2].b) - b2 === BigInt(r.prizes[2]));
  t('rang invalide refusé', !w.c.call(P[0], 'claim', [1, 3]).success);
  t('tombola non tirée : refus', !w.c.call(P[0], 'claim', [2, 0]).success);
  w.chain.mine(100000);
  t('prix réclamable bien plus tard (pas d\'expiration)', w.c.call(win[1].b, 'claim', [1, 1]).success);
  t('tout payé', w.st().owed === '0' && balanceOk(w));
}

sec('Cas extrême : 3 wallets seulement (10 / 10 / 1 tickets)');
{
  let fails = 0, maxGas = 0;
  for (let k = 0; k < 15; k++) {
    const w = world();
    w.buy(P[0], 10); w.buy(P[1], 10); w.buy(P[2], 1, k.toString(16));
    const d = w.draw(1);
    if (!d.success) fails++; else maxGas = Math.max(maxGas, d.gas);
    if (d.success && new Set(w.round(1).win.map((x) => x.b)).size !== 3) fails++;
  }
  t('15 tirages réussis, toujours 3 wallets différents (gas max ' + maxGas + ')', fails === 0 && maxGas < 1_000_000);
}

sec('Cas extrême : 20 tickets par wallet (20 / 1 / 1)');
{
  let fails = 0;
  for (let k = 0; k < 15; k++) {
    const w = world();
    w.c.call(ADMIN, 'setConfig', [PRICE.toString(), 0, 21, 0, 20, 10, 120, 10000]);
    w.buy(P[0], 20); w.buy(P[1], 1); w.buy(P[2], 1, k.toString(16));
    const d = w.draw(1);
    if (!d.success || new Set(w.round(1).win.map((x) => x.b)).size !== 3 || d.gas >= 1_000_000) fails++;
  }
  t('15 tirages réussis', fails === 0);
  t('plus de 20 tickets par wallet refusé', !world().c.call(ADMIN, 'setConfig', [PRICE.toString(), 0, 21, 0, 21, 10, 120, 10000]).success);
}

sec('Grosse tombola : 500 wallets × 10 tickets');
{
  const w = world();
  for (let i = 0; i < 500; i++) { const r = w.buy(P[i], 10); if (!r.success) throw new Error(r.error); }
  w.close(1); w.revealO(1);
  const rc = w.revealC(1);
  t('5000 tickets : tirage OK, gas ' + rc.gas + ' < 1 000 000', rc.success && rc.gas < 1_000_000, rc.error);
  const r = w.round(1);
  const all = [];
  for (let i = 0; i < r.buys; i += 400) all.push(...w.c.view('getPurchases', [1, i, 400]).map((p) => ({ b: p.b, n: p.n, first: p.first })));
  t('= référence', JSON.stringify(r.win) === JSON.stringify(ref.raffleWinners(1, r.sO, r.sC, r.digest, all)));
}

sec('Secret en retard : le tirage attend');
{
  const w = world();
  w.buy(P[0], 2); w.buy(P[1], 1); w.buy(P[2], 4);
  w.close(1); w.revealO(1);
  w.chain.mineUntil(w.round(1).closeTs + 3 * 86400000);
  t('aucune fonction d\'annulation ni de remboursement', !w.c.api.cancelExpired && !w.c.api.emergencyCancel && !w.c.api.settle);
  t('la tombola 2 se vend pendant l\'attente', w.buy(P[3], 1).success && w.st().cur === 2);
  t('collab révèle 3 jours plus tard : tirage OK', w.revealC(1).success && w.round(1).status === 'done');
  t('solde cohérent', balanceOk(w));
}

sec('Admin');
{
  const w = world();
  for (const [m, a] of [['setPaused', [true]], ['setConfig', [PRICE.toString(), 0, 21, 0, 10, 10, 120, 10000]], ['setPayouts', [P[0], P[0]]], ['setAdmin', [P[0]]], ['setTipOwner', ['a'.repeat(64)]]])
    t(`${m} refusé à un joueur`, !w.c.call(P[0], m, a).success);
  t('pause', w.c.call(ADMIN, 'setPaused', [true]).success && !w.buy(P[0], 1).success);
  w.c.call(ADMIN, 'setPaused', [false]);
  t('setConfig : vendredi 20h, 3 ASE, 5 par wallet', w.c.call(ADMIN, 'setConfig', [(3n * ASE).toString(), 5, 20, 0, 5, 10, 120, 10000]).success);
  const r = w.round(1);
  t('appliqué tout de suite (aucun ticket) : vendredi 16/10 20:00', new Date(r.drawTs).toISOString() === '2026-10-16T18:00:00.000Z' && r.price === (3n * ASE).toString(), new Date(r.drawTs).toISOString());
  t('6e ticket refusé (5 max)', w.c.call(P[0], 'buy', [5, ''], 15n * ASE).success && !w.c.call(P[0], 'buy', [1, ''], 3n * ASE).success);
  for (const bad of [['1', 0, 21, 0, 10, 10, 120, 100], [PRICE.toString(), 7, 21, 0, 10, 10, 120, 100], [PRICE.toString(), 0, 5, 0, 10, 10, 120, 100], [PRICE.toString(), 0, 21, 0, 0, 10, 120, 100], [PRICE.toString(), 0, 21, 0, 21, 10, 120, 100], [PRICE.toString(), 0, 21, 0, 10, 1, 120, 100], [PRICE.toString(), 0, 21, 0, 10, 10, 120, 2]])
    t('setConfig hors bornes refusé ' + JSON.stringify(bad), !w.c.call(ADMIN, 'setConfig', bad).success);
  t('aucune fonction de retrait', !Object.keys(w.c.api).some((k) => /withdraw|sweep|drain|rescue/i.test(k)));
  t('solde cohérent', balanceOk(w));
}

sec('Heure d\'hiver (25/10/2026)');
{
  const w = world({ start: Date.UTC(2026, 9, 20, 12) });
  t('dimanche 25/10 21:00 Paris = 20:00 UTC', new Date(w.round(1).drawTs).toISOString() === '2026-10-25T20:00:00.000Z', new Date(w.round(1).drawTs).toISOString());
}

sec('Simulation : 52 semaines, conservation au wei près');
{
  const w = world();
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let draws = 0, ext = 0, partial = 0;
  for (let k = 0; k < 52; k++) {
    const id = w.st().cur;
    const x0 = rnd(), nWallets = x0 < 0.05 ? 0 : x0 < 0.15 ? 1 + Math.floor(rnd() * 2) : 3 + Math.floor(rnd() * 60);
    for (let i = 0; i < nWallets; i++) { const who = P[Math.floor(rnd() * 600)]; const have = w.c.view('getWallet', [id, who]); if (have < 10) w.buy(who, 1 + Math.floor(rnd() * (10 - have))); }
    w.close(id);
    if (w.round(id).status === 'open') { ext++; continue; }
    w.revealO(id); const x = w.revealC(id); if (!x.success) throw new Error(x.error); draws++;
    if (w.round(id).win.length < 3) partial++;
    for (let r = 0; r < 3; r++) if (rnd() < 0.8) w.c.call(P[0], 'claim', [id, r]);
    const s = w.st(), T = s.tot;
    let pend = 0n; for (let j = s.next; j <= s.cur; j++) { const x = w.round(j); if (['open', 'closed'].includes(x.status)) pend += BigInt(x.carryIn) + BigInt(x.sales) - BigInt(x.commission); }
    if (BigInt(T.sales) !== BigInt(T.commission) + BigInt(T.prizes) + BigInt(s.owed) + pend) throw new Error('conservation violée');
    if (!balanceOk(w)) throw new Error('solde incohérent');
  }
  t(`52 semaines : ${draws} tirages (${partial} partiels), ${ext} reports, conservation OK`, draws > 30 && partial > 0);
}

console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
