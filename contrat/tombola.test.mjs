// Tests automatisés de la tombola v4 : node contrat/tombola.test.mjs
import { readFileSync } from 'node:fs';
import { Chain } from '../sim/vm-sim.mjs';
import * as ref from './ref.mjs';

const FILE = process.env.TOMBOLA_FILE || './tombola.js';
const SRC = readFileSync(new URL(FILE, import.meta.url), 'utf8');
const ASE = 10n ** 18n, PRICE = 5n * ASE, LOT = 100n * ASE;
let ok = 0, ko = 0, section = '';
const t = (name, cond, extra = '') => { if (cond) ok++; else { ko++; console.log(`  ✗ [${section}] ${name}`, extra); } };
const sec = (n) => { section = n; console.log('•', n); };
const ADMIN = '0x' + 'a'.repeat(40), OWNER_PAY = '0x' + 'b'.repeat(40), COLLAB = '0x' + 'c'.repeat(40);
const DROP = '0x' + 'f'.repeat(40);
const P = Array.from({ length: 1200 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
const iso = (ms) => new Date(ms).toISOString();

function world({ start = Date.UTC(2026, 9, 10, 12, 0) } = {}) {   // samedi 10/10/2026
  const chain = new Chain({ startTimestampMs: start, blockTimeMs: 8000 });
  for (const a of [ADMIN, OWNER_PAY, COLLAB, ...P]) chain.fund(a, 1000000n * ASE);
  const c = chain.deploy(SRC, ADMIN);
  const chO = ref.makeChain(200), chC = ref.makeChain(200);
  const r = c.call(ADMIN, 'init', [OWNER_PAY, COLLAB, COLLAB, chO[200], chC[200], DROP]);
  if (!r.success) throw new Error('init: ' + r.error);
  const w = {
    chain, c, chO, chC,
    st: () => c.view('getState'), round: (id) => c.view('getRound', [id]),
    buy: (who, n, seed = '') => c.call(who, 'buy', [n, seed], PRICE * BigInt(n)),
    close: (id) => { chain.mineUntil(w.round(id).closeTs); chain.mine(1); return c.call(P[1199], 'poke'); },
    revealO: (id) => c.call(ADMIN, 'reveal', ['owner', id, ref.preimageOf(w.chO, w.st().tipO)]),
    revealC: (id) => c.call(COLLAB, 'reveal', ['collab', id, ref.preimageOf(w.chC, w.st().tipC)]),
    draw: (id) => { w.close(id); const a = w.revealO(id); if (!a.success) return a; return w.revealC(id); },
    purchases: (id) => { const r = w.round(id), out = []; for (let i = 0; i < r.buys; i += 400) out.push(...c.view('getPurchases', [id, i, 400])); return out; },
    idxOf: (id, tk) => w.purchases(id).find((p) => p.first <= tk && tk < p.first + p.n),
    expectedBalance: () => {
      const s = w.st(); let pend = 0n;
      for (let id = s.next; id <= s.cur; id++) { const r = w.round(id); if (['open', 'closed'].includes(r.status)) pend += BigInt(r.carryIn) + BigInt(r.sales) - BigInt(r.commission); }
      return pend + BigInt(s.owed);
    },
  };
  return w;
}
const balanceOk = (w) => w.chain.balanceOf(w.c.address) === w.expectedBalance();
const pool = (r) => BigInt(r.carryIn) + BigInt(r.sales) - BigInt(r.commission);

sec('Initialisation et calendrier dimanche / mardi / jeudi');
{
  const w = world();
  const cfg = w.c.view('getConfig');
  t('prix 5 ASE, 10 par wallet, jours 21, 27 lots de 100 ASE', cfg.price === PRICE.toString() && cfg.maxPerWallet === 10 && cfg.drawDays === 21 && cfg.lot === LOT.toString() && cfg.maxLots === 27);
  t('samedi → 1er tirage dimanche 11/10 21:00 Paris', iso(w.round(1).drawTs) === '2026-10-11T19:00:00.000Z', iso(w.round(1).drawTs));
  t('fermeture 20:50', ref.parisHM(w.round(1).closeTs) === '20:50');
  t('lots figés dans la tombola', w.round(1).lot === LOT.toString() && w.round(1).maxLots === 27);
  const seq = [];
  for (let k = 0; k < 7; k++) { const id = w.st().cur; w.buy(P[k], 1); w.close(id); seq.push(iso(w.round(id).drawTs)); }
  t('dim 11, mar 13, jeu 15, dim 18, mar 20, jeu 22, dim 25 (heure d\'hiver)', JSON.stringify(seq) === JSON.stringify(['2026-10-11T19:00:00.000Z', '2026-10-13T19:00:00.000Z', '2026-10-15T19:00:00.000Z', '2026-10-18T19:00:00.000Z', '2026-10-20T19:00:00.000Z', '2026-10-22T19:00:00.000Z', '2026-10-25T20:00:00.000Z']), JSON.stringify(seq));
  const w2 = world({ start: Date.UTC(2026, 9, 13, 18, 55) });   // mardi 20:55 Paris, après la fermeture
  t('ouverte après la fermeture du mardi → jeudi', iso(w2.round(1).drawTs) === '2026-10-15T19:00:00.000Z', iso(w2.round(1).drawTs));
  t('double init refusé', !w.c.call(ADMIN, 'init', [OWNER_PAY, COLLAB, COLLAB, w.chO[200], w.chC[200], DROP]).success);
}

sec('Achats et commission');
{
  const w = world();
  const bO = w.chain.balanceOf(OWNER_PAY), bC = w.chain.balanceOf(COLLAB);
  let r = w.buy(P[0], 3, 'ab');
  t('3 tickets', r.success && r.returnValue.first === 0 && r.returnValue.n === 3, r.error);
  t('2e acheteur : tickets 3-4', w.buy(P[1], 2).returnValue.first === 3);
  t('total 10 OK, 11e refusé', w.buy(P[0], 7).success && !w.buy(P[0], 1).success);
  const com = 12n * PRICE * 15n / 100n, drop = com * 6n / 15n, own = (com - drop) * 3n / 4n;
  t('commission 15 % versée tout de suite', w.chain.balanceOf(DROP) === drop && w.chain.balanceOf(OWNER_PAY) - bO === own && w.chain.balanceOf(COLLAB) - bC === com - drop - own);
  let d = ref.raffleInitialDigest(1);
  [[P[0], 3, 'ab'], [P[1], 2, ''], [P[0], 7, '']].forEach(([b, n, s], i) => (d = ref.raffleNextDigest(d, b, n, s, i)));
  t('empreinte = référence', w.round(1).digest === d);
  t('mauvais montant / graine invalide refusés', !w.c.call(P[2], 'buy', [2, ''], PRICE).success && !w.c.call(P[2], 'buy', [1, 'zz'], PRICE).success);
  t('solde cohérent', balanceOk(w));
}

sec('Aucun ticket → reportée au tirage suivant');
{
  const w = world();
  const a = w.round(1).drawTs;
  w.close(1);
  const r = w.round(1);
  t('même tombola, tirage du mardi', r.status === 'open' && w.st().cur === 1 && r.drawTs - a === 2 * 86400000 && r.weeks === 2, iso(r.drawTs));
}

// Tirage complet vérifié contre la référence
function checkDraw(w, id, label) {
  const r = w.round(id), exp = ref.rafflePrizesV4(pool(r), r.tickets, BigInt(r.lot), r.maxLots);
  t(label + ' : prix = référence', JSON.stringify(r.prizes) === JSON.stringify(exp.prizes.map(String)) && r.carryOut === exp.carry.toString(), JSON.stringify([r.prizes.slice(0, 4), exp.prizes.slice(0, 4).map(String)]));
  t(label + ' : tickets gagnants = référence', JSON.stringify(r.win) === JSON.stringify(ref.raffleTicketsV4(id, r.sO, r.sC, r.digest, r.tickets, r.prizes.length)));
  t(label + ' : tickets tous différents', new Set(r.win).size === r.win.length);
  return { r, exp };
}

sec('Grosse cagnotte : 9 700 ASE → 27 lots + 3 500 / 2 100 / 1 400');
{
  const w = world();
  // 9 700 ASE de cagnotte = 85 % des ventes → 2 282,35 tickets : 2 283 tickets
  let n = 0, i = 0;
  while (n < 2283) { const k = Math.min(10, 2283 - n); w.buy(P[i++], k); n += k; }
  w.close(1); w.revealO(1);
  const rc = w.revealC(1);
  t('tirage OK, gas ' + rc.gas, rc.success && rc.gas < 1_000_000, rc.error);
  const { r } = checkDraw(w, 1, '2 283 tickets');
  t('30 gagnants : 3 + 27 lots de 100 ASE', r.prizes.length === 30 && r.prizes.slice(3).every((x) => x === LOT.toString()));
  t('1er ≈ 3 500 ASE (50 % de ce qui reste après les lots)', BigInt(r.prizes[0]) === (pool(r) - 27n * LOT) / 2n);
  t('rien reporté', r.carryOut === '0');
  t('dû = toute la cagnotte', w.st().owed === pool(r).toString() && balanceOk(w));

  sec('Réclamer');
  const ps = w.purchases(1);
  const own = (k) => ps.find((p) => p.first <= r.win[k] && r.win[k] < p.first + p.n);
  const p0 = own(0), b0 = w.chain.balanceOf(p0.b);
  t('mauvais achat refusé', !w.c.call(P[0], 'claim', [1, 0, own(0).idx === 0 ? 1 : 0]).success);
  const cl = w.c.call(P[1199], 'claim', [1, 0, p0.idx]);
  t('1er prix réclamé (par un tiers), payé à l\'acheteur du ticket', cl.success && w.chain.balanceOf(p0.b) - b0 === BigInt(r.prizes[0]), cl.error);
  t('double réclamation refusée', !w.c.call(P[0], 'claim', [1, 0, p0.idx]).success);
  let all = true;
  for (let k = 1; k < 30; k++) if (!w.c.call(P[0], 'claim', [1, k, own(k).idx]).success) all = false;
  t('les 29 autres prix réclamés', all);
  t('rang 30 inexistant refusé', !w.c.call(P[0], 'claim', [1, 30, 0]).success);
  t('tout payé, solde cohérent', w.st().owed === '0' && balanceOk(w));
}

sec('Cagnotte moyenne : 6 400 ASE → lots limités à 40 %');
{
  const w = world();
  let n = 0, i = 0;
  while (n < 1506) { const k = Math.min(10, 1506 - n); w.buy(P[i++], k); n += k; }
  const d = w.draw(1);
  const { r } = checkDraw(w, 1, '1 506 tickets');
  t('25 lots de 100 + 1 dernier lot avec le reste (40 % de 6 400 = 2 560 → 60 ASE)', d.success && r.prizes.length === 29 && r.prizes.slice(3, 28).every((x) => x === LOT.toString()) && BigInt(r.prizes[28]) > 59n * ASE && BigInt(r.prizes[28]) < 61n * ASE, r.prizes.length + ' ' + r.prizes[28]);
}

sec('Petite cagnotte : 3 000 ASE → 12 lots (+ le petit reste) + 900 / 540 / 360');
{
  const w = world();
  let n = 0, i = 0;
  while (n < 706) { const k = Math.min(10, 706 - n); w.buy(P[i++], k); n += k; }
  w.draw(1);
  const { r } = checkDraw(w, 1, '706 tickets');
  t('12 lots de 100 + un dernier lot avec le reste (< 1 ASE)', r.prizes.length === 16 && BigInt(r.prizes[15]) < ASE, r.prizes.length);
}

sec('Peu de tickets');
{
  const w = world();
  w.buy(P[0], 10);
  w.draw(1);
  const { r } = checkDraw(w, 1, '10 tickets / 1 wallet');
  t('42,5 ASE de cagnotte : 1 petit lot (pas plus que le 3e prix), 4 prix gagnés par le même wallet', r.prizes.length === 4 && BigInt(r.prizes[3]) <= BigInt(r.prizes[2]) && r.carryOut === '0', JSON.stringify(r.prizes));
  const w2 = world();
  w2.buy(P[0], 2);
  w2.draw(1);
  const x = checkDraw(w2, 1, '2 tickets');
  t('2 tickets → 2 prix, le 3e reporté à la tombola 2', x.r.prizes.length === 2 && BigInt(x.r.carryOut) > 0n && w2.round(2).carryIn === x.r.carryOut);
  t('solde cohérent', balanceOk(w2));
  // beaucoup d'argent (report) mais peu de tickets → lots limités par les tickets
  w2.c.call(ADMIN, 'setLots', [(1n * ASE).toString(), 27]);   // pour la tombola 3
  w2.buy(P[1], 5);
  w2.draw(2);
  const y = checkDraw(w2, 2, '5 tickets + report');
  t('petite cagnotte : lots jamais plus gros que le 3e prix ; lot de la tombola 2 inchangé', y.r.prizes.slice(3).every((x) => BigInt(x) <= BigInt(y.r.prizes[2])) && y.r.lot === LOT.toString(), JSON.stringify(y.r.prizes));
  t('nouveau lot (1 ASE) appliqué à la tombola 3', w2.round(3).lot === ASE.toString());
}

sec('Plusieurs prix pour un même wallet');
{
  const w = world();
  w.c.call(ADMIN, 'setConfig', [PRICE.toString(), 21, 21, 0, 100, 10, 120, 100000]);
  w.buy(P[0], 100);
  for (let i = 1; i <= 5; i++) w.buy(P[i], 1);
  // report artificiel : on gonfle via plusieurs tombolas ? On vérifie simplement 1 wallet = plusieurs prix
  w.draw(1);
  const { r } = checkDraw(w, 1, '105 tickets');
  const ps = w.purchases(1);
  const wins = r.win.filter((tk) => ps[0].first <= tk && tk < ps[0].first + ps[0].n).length;
  t('le gros acheteur peut gagner plusieurs prix', wins >= 2, wins);
}

sec('Secrets');
{
  const w = world();
  w.buy(P[0], 2); w.buy(P[1], 3);
  t('révélation avant fermeture refusée', !w.revealO(1).success);
  w.close(1);
  t('collab avant owner refusé', !w.revealC(1).success);
  t('owner : 2 maillons plus loin refusé', !w.c.call(ADMIN, 'reveal', ['owner', 1, w.chO[198]]).success);
  t('owner OK', w.revealO(1).success);
  w.chain.mineUntil(w.round(1).closeTs + 3 * 86400000);
  t('ventes de la tombola 2 pendant l\'attente', w.buy(P[3], 1).success && w.st().cur >= 2);
  t('collab révèle plus tard : tirage OK', w.revealC(1).success && w.round(1).status === 'done');
  t('aucune fonction d\'annulation / retrait', !Object.keys(w.c.api).some((k) => /withdraw|sweep|drain|rescue|cancel/i.test(k)));
}

sec('Admin');
{
  const w = world();
  for (const [m, a] of [['setPaused', [true]], ['setConfig', [PRICE.toString(), 21, 21, 0, 10, 10, 120, 10000]], ['setLots', [LOT.toString(), 27]], ['setPayouts', [P[0], P[0]]], ['setAdmin', [P[0]]]])
    t(`${m} refusé à un joueur`, !w.c.call(P[0], m, a).success);
  t('setConfig : tous les jours (127) à 20h, 3 ASE', w.c.call(ADMIN, 'setConfig', [(3n * ASE).toString(), 127, 20, 0, 10, 10, 120, 10000]).success);
  t('appliqué tout de suite (aucun ticket) : samedi 10/10 20:00', iso(w.round(1).drawTs) === '2026-10-10T18:00:00.000Z' && w.round(1).price === (3n * ASE).toString(), iso(w.round(1).drawTs));
  for (const bad of [[PRICE.toString(), 0, 21, 0, 10, 10, 120, 100], [PRICE.toString(), 128, 21, 0, 10, 10, 120, 100], [PRICE.toString(), 21, 21, 0, 101, 10, 120, 100]])
    t('setConfig hors bornes refusé ' + JSON.stringify(bad), !w.c.call(ADMIN, 'setConfig', bad).success);
  t('setLots hors bornes refusé', !w.c.call(ADMIN, 'setLots', [LOT.toString(), 201]).success && !w.c.call(ADMIN, 'setLots', ['-1', 2]).success);
  t('setLots(0, 0) : plus de lots', w.c.call(ADMIN, 'setLots', ['0', 0]).success);
  t('solde cohérent', balanceOk(w));
}

sec('Très grosse tombola : 1 000 wallets × 20 tickets, 200 lots');
{
  const w = world();
  w.c.call(ADMIN, 'setConfig', [PRICE.toString(), 21, 21, 0, 20, 10, 120, 100000]);
  w.c.call(ADMIN, 'setLots', [LOT.toString(), 200]);
  w.close(1);   // tombola 1 vide → reportée ; les lots changent à la tombola suivante seulement
  const id = 1;
  for (let i = 0; i < 1000; i++) { const r = w.buy(P[i], 20); if (!r.success) throw new Error(r.error); }
  w.close(id); w.revealO(id);
  const rc = w.revealC(id);
  t('20 000 tickets : tirage OK, gas ' + rc.gas, rc.success && rc.gas < 1_000_000, rc.error);
  checkDraw(w, id, '20 000 tickets');
}

sec('Simulation : 150 tirages, conservation au wei près');
{
  const w = world();
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let draws = 0, ext = 0;
  for (let k = 0; k < 150; k++) {
    const id = w.st().cur;
    const x0 = rnd(), nW = x0 < 0.05 ? 0 : x0 < 0.15 ? 1 + Math.floor(rnd() * 2) : 3 + Math.floor(rnd() * 120);
    for (let i = 0; i < nW; i++) { const who = P[Math.floor(rnd() * 1200)]; const have = w.c.view('getWallet', [id, who]); if (have < 10) w.buy(who, 1 + Math.floor(rnd() * (10 - have))); }
    w.close(id);
    if (w.round(id).status === 'open') { ext++; continue; }
    w.revealO(id); const x = w.revealC(id); if (!x.success) throw new Error(x.error); draws++;
    const r = w.round(id), ps = w.purchases(id);
    for (let q = 0; q < r.win.length; q++) if (rnd() < 0.7) { const p = ps.find((p) => p.first <= r.win[q] && r.win[q] < p.first + p.n); w.c.call(P[0], 'claim', [id, q, p.idx]); }
    const s = w.st(), T = s.tot;
    let pend = 0n; for (let j = s.next; j <= s.cur; j++) { const y = w.round(j); if (['open', 'closed'].includes(y.status)) pend += BigInt(y.carryIn) + BigInt(y.sales) - BigInt(y.commission); }
    if (BigInt(T.sales) !== BigInt(T.commission) + BigInt(T.prizes) + BigInt(s.owed) + pend) throw new Error('conservation violée');
    if (!balanceOk(w)) throw new Error('solde incohérent');
  }
  t(`150 tours : ${draws} tirages, ${ext} reports, conservation OK`, draws > 100);
}

console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
