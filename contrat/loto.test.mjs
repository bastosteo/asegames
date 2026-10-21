// Tests automatisés du contrat loto : node contrat/loto.test.mjs
import { readFileSync } from 'node:fs';
import { Chain } from '../sim/vm-sim.mjs';
import * as ref from './ref.mjs';

const SRC = readFileSync(new URL(process.env.LOTO_FILE || './loto.js', import.meta.url), 'utf8');
const ASE = 10n ** 18n;
const M = ref.MAXN;                          // 14 (v6) ; LOTO_MAXN=20 pour les anciennes versions
const PRICE = 2n * ASE;                      // prix utilisé par les tests (world() le règle)
const DEFAULT_PRICE = M === 20 ? 2n * ASE : ASE;   // prix par défaut du contrat testé
const CAP = M === 20 ? 3000 : M === 15 ? 2000 : 1000;   // plafond de grilles par tirage par défaut

let ok = 0, ko = 0, section = '';
function t(name, cond, extra = '') {
  if (cond) ok++;
  else { ko++; console.log(`  ✗ [${section}] ${name}`, extra); }
}
function sec(name) { section = name; console.log('•', name); }

// Adresses de test (les 2 premières : vraies adresses de ton compte "test", pour
// valider la conversion ase1 → 0x avec des données réelles).
const ADMIN = '0x' + 'a'.repeat(40);
const OWNER_PAY = '0x' + 'b'.repeat(40);
const COLLAB = '0x' + 'c'.repeat(40);
const DROP = '0x' + 'f'.repeat(40);   // contrat ASE Airdrop (cagnotte)
const P = ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40), '0x' + '3'.repeat(40), '0x' + '4'.repeat(40)];

// Un monde neuf : chaîne simulée + contrat déployé + initialisé.
// Départ : samedi 10/10/2026 12:00 UTC (14h00 à Paris).
function world({ start = Date.UTC(2026, 9, 10, 12, 0), raw = false } = {}) {
  const chain = new Chain({ startTimestampMs: start, blockTimeMs: 8000 });
  for (const a of [ADMIN, OWNER_PAY, COLLAB, ...P]) chain.fund(a, 100000n * ASE);
  const c = chain.deploy(SRC, ADMIN);
  const chO = ref.makeChain(200), chC = ref.makeChain(200);
  const r = c.call(ADMIN, 'init', [OWNER_PAY, COLLAB, COLLAB, chO[200], chC[200], DROP]);
  if (!r.success) throw new Error('init: ' + r.error);
  if (!raw) { const k = c.view('getConfig'); if (M === 15) c.call(ADMIN, 'setConfig', [PRICE.toString(), k.drawH, k.drawM, 20, k.closeMin, k.revealMin, CAP, CAP]); else if (k.price !== PRICE.toString()) c.call(ADMIN, 'setConfig', [PRICE.toString(), k.drawH, k.drawM, k.maxGrids, k.closeMin, k.revealMin]); }   // v7 : 20 par achat, sans limite par wallet pour les anciens tests
  const w = {
    chain, c, chO, chC,
    st: () => c.view('getState'),
    round: (id) => c.view('getRound', [id]),
    buy: (who, grids, seed = '') => c.call(who, 'buy', [grids, seed], PRICE * BigInt(grids.length)),
    // Avance jusqu'à la fermeture du tour id
    close: (id) => { chain.mineUntil(w.round(id).closeTs); chain.mine(1); c.call(P[3], 'poke'); },
    revealO: (id) => c.call(ADMIN, 'reveal', ['owner', id, ref.preimageOf(w.chO, w.st().tipO)]),
    revealC: (id) => c.call(COLLAB, 'reveal', ['collab', id, ref.preimageOf(w.chC, w.st().tipC)]),
    tallyAll: (id) => { let r; do { r = c.call(ADMIN, 'tally', [id, 300]); if (!r.success) return r; } while (!r.returnValue.done); return r; },
    draw: (id) => { w.close(id); const a = w.revealO(id); if (!a.success) return a; const b = w.revealC(id); if (!b.success) return b; return w.tallyAll(id); },
    payAll: (id) => { const n = w.round(id).buys; let i = 0, maxGas = 0; while (i < n) { const r = c.call(ADMIN, 'settle', [id, i, 100]); if (!r.success) return r; maxGas = Math.max(maxGas, r.gas); i = r.returnValue.next; } return { success: true, maxGas }; },
    // Argent qui DOIT être dans le contrat : ventes non tirées + jackpot + dettes
    expectedBalance: () => {
      const s = w.st();
      let pend = 0n;
      for (let id = s.next; id <= s.cur; id++) {
        const r = w.round(id);
        if (['open', 'closed', 'tally'].includes(r.status)) pend += BigInt(r.sales) - BigInt(r.commission);   // commission déjà versée
      }
      return pend + BigInt(s.jackpot) + BigInt(s.owed);
    },
  };
  return w;
}
const balanceOk = (w) => w.chain.balanceOf(w.c.address) === w.expectedBalance();

// ---------------------------------------------------------------------
sec('Initialisation');
{
  const w = world({ raw: true });
  const cfg = w.c.view('getConfig');
  t('admin = déployeur', cfg.admin === ADMIN);
  t('prix par défaut ' + DEFAULT_PRICE / ASE + ' ASE', cfg.price === DEFAULT_PRICE.toString());
  t('plafond ' + CAP + ' grilles par tirage, ' + (M === 15 ? '15' : '20') + ' par achat', cfg.maxRound === CAP && cfg.maxGrids === (M === 15 ? 15 : 20) && (M !== 15 || cfg.maxWallet === 15));
  t('double init refusé', !w.c.call(ADMIN, 'init', [OWNER_PAY, COLLAB, COLLAB, w.chO[200], w.chC[200], DROP]).success);
  const r1 = w.round(1);
  t('tour 1 ouvert', r1.status === 'open');
  t('tirage à 21:00 heure de Paris', ref.parisHM(r1.drawTs) === '21:00', ref.parisHM(r1.drawTs));
  t('fermeture à 20:50 heure de Paris', ref.parisHM(r1.closeTs) === '20:50', ref.parisHM(r1.closeTs));
  t('tirage le jour même (10/10)', new Date(r1.drawTs).toISOString().startsWith('2026-10-10T19:00'), new Date(r1.drawTs).toISOString());

  // Le contrat n'accepte que des adresses 0x (le site, le croupier et le guide convertissent les ase1).
  const chain3 = new Chain(); chain3.fund(ADMIN, ASE);
  const c3 = chain3.deploy(SRC, ADMIN);
  t('adresse ase1 refusée par le contrat (conversion avant envoi)', !c3.call(ADMIN, 'init', ['ase1hypqm76acwd7lwvfsh396psdd5fm8zf35pjupv', COLLAB, COLLAB, w.chO[5], w.chC[5], DROP]).success);
  t('adresse 0x en majuscules acceptée et normalisée', (() => { const ch = new Chain(); ch.fund(ADMIN, ASE); const k = ch.deploy(SRC, ADMIN); const r = k.call(ADMIN, 'init', ['0xB9020DFB5DC39BEFB98985E25D060D6D13B38931', COLLAB, COLLAB, w.chO[5], w.chC[5], DROP]); return r.success && k.view('getConfig').payOwner === '0xb9020dfb5dc39befb98985e25d060d6d13b38931'; })());
}

// ---------------------------------------------------------------------
sec('Achat');
{
  const w = world();
  let r = w.buy(P[0], [[5, 3, 1, 2, 4], [14, 13, 12, 11, 10]], 'abcd');
  t('achat de 2 grilles réussi', r.success, r.error);
  const pur = w.c.view('getPurchases', [1, 0, 10]);
  t('grilles triées et enregistrées', JSON.stringify(pur[0].g) === '[[1,2,3,4,5],[10,11,12,13,14]]');
  t('acheteur enregistré', pur[0].b === P[0]);
  t('événement Buy émis (avec la graine)', r.events.some((e) => e.name === 'Buy' && e.data.grids === '[[1,2,3,4,5],[10,11,12,13,14]]' && e.data.seed === 'abcd'));
  t('contrat garde 85 % de 4 ASE (commission versée tout de suite)', w.chain.balanceOf(w.c.address) === 2n * PRICE * 85n / 100n);
  t('Airdrop reçoit 6 % dès l\'achat', w.chain.balanceOf(DROP) === 2n * PRICE * 6n / 100n && w.round(1).airdrop === (2n * PRICE * 6n / 100n).toString());
  t('achat horodaté', pur[0].t > 0);
  const rd = w.round(1);
  t('ventes du tour = 4 ASE, 2 grilles, 1 achat', rd.sales === (2n * PRICE).toString() && rd.grids === 2 && rd.buys === 1);
  let d = ref.nextDigest(ref.initialDigest(1), P[0], [[1, 2, 3, 4, 5], [10, 11, 12, 13, 14]], 'abcd', 0);
  t('empreinte des grilles recalculable (référence indépendante)', rd.digest === d);
  t('gas d\'un achat de 20 grilles < 1 000 000', (() => {
    const g = Array.from({ length: 20 }, () => ref.randomGrid());
    const x = w.buy(P[1], g); return x.success && x.gas < 1_000_000;
  })());
  t('solde cohérent', balanceOk(w));
}

sec('Grilles invalides');
{
  const w = world();
  const bad = (name, grids, value) => {
    const r = w.c.call(P[0], 'buy', [grids, ''], value ?? PRICE * BigInt(Array.isArray(grids) ? grids.length : 1));
    t(name, !r.success, 'aurait dû échouer');
  };
  bad('numéro en double refusé', [[1, 1, 2, 3, 4]]);
  bad('numéro 0 refusé', [[0, 1, 2, 3, 4]]);
  t(`numéros ${M - 1} et ${M} acceptés`, w.buy(P[1], [[M - 4, M - 3, M - 2, M - 1, M]]).success);
  bad(`numéro ${M + 1} refusé`, [[1, 2, 3, 4, M + 1]]);
  if (M < 20) bad('numéro 20 refusé (5 sur ' + M + ')', [[1, 2, 3, 4, 20]]);
  bad('numéro décimal refusé', [[1.5, 2, 3, 4, 5]]);
  bad('texte refusé', [['a', 2, 3, 4, 5]]);
  bad('4 numéros refusés', [[1, 2, 3, 4]]);
  bad('6 numéros refusés', [[1, 2, 3, 4, 5, 6]]);
  bad('aucune grille refusée', []);
  bad('montant insuffisant refusé', [[1, 2, 3, 4, 5]], PRICE - 1n);
  bad('montant en trop refusé', [[1, 2, 3, 4, 5]], PRICE + 1n);
  bad('21 grilles refusées (plafond 20)', Array.from({ length: 21 }, () => [1, 2, 3, 4, 5]));
  t('rien encaissé après tous ces refus', w.chain.balanceOf(w.c.address) === PRICE * 85n / 100n);
  t('graine non hexa refusée', !w.c.call(P[0], 'buy', [[[1, 2, 3, 4, 5]], 'zz'], PRICE).success);
}

// ---------------------------------------------------------------------
sec('Fermeture et tour suivant');
{
  const w = world();
  w.buy(P[0], [[1, 2, 3, 4, 5]]);
  const r1 = w.round(1);
  w.chain.mineUntil(r1.closeTs);
  const r = w.buy(P[1], [[6, 7, 8, 9, 10]]);
  t('achat après 20:50 accepté… pour le tour 2', r.success && r.returnValue.round === 2, JSON.stringify(r.returnValue));
  t('tour 1 fermé', w.round(1).status === 'closed');
  t('tour 2 : tirage le lendemain 21:00 Paris', ref.parisHM(w.round(2).drawTs) === '21:00' && w.round(2).drawTs - r1.drawTs === 86400000);
  t('grilles du tour 1 inchangées', w.round(1).grids === 1);
  // tour vide : clôturé sans tirage
  w.chain.mineUntil(w.round(2).closeTs); w.c.call(P[0], 'poke');
  w.chain.mineUntil(w.round(3).closeTs); w.c.call(P[0], 'poke');
  t('tour sans grille marqué "empty"', w.round(3).status === 'empty');
}

// ---------------------------------------------------------------------
sec('Tirage et ordre des révélations');
{
  const w = world();
  for (let i = 0; i < 4; i++) w.buy(P[i], [ref.randomGrid(), ref.randomGrid()]);
  t('révélation owner AVANT fermeture refusée', !w.revealO(1).success);
  w.close(1);
  t('collaborateur avant owner refusé', !w.revealC(1).success);
  t('mauvais secret owner refusé', !w.c.call(ADMIN, 'reveal', ['owner', 1, ref.makeChain(1)[0]]).success);
  t('bout de chaîne lui-même refusé (pas une pré-image)', !w.c.call(ADMIN, 'reveal', ['owner', 1, w.chO[200]]).success);
  t('révélation owner OK', w.revealO(1).success);
  t('double révélation owner refusée', !w.c.call(ADMIN, 'reveal', ['owner', 1, w.chO[199]]).success);
  const rc = w.revealC(1);
  t('révélation collaborateur OK', rc.success, rc.error);
  const rd = w.round(1);
  const exp = ref.drawNumbers(1, w.chO[199], w.chC[199], rd.digest);
  t('numéros = référence indépendante', JSON.stringify(rd.nums) === JSON.stringify(exp), JSON.stringify([rd.nums, exp]));
  t('5 numéros distincts entre 1 et 20', rd.nums.length === 5 && new Set(rd.nums).size === 5 && rd.nums.every((n) => n >= 1 && n <= 20));
    t('statut "tally"', rd.status === 'tally');
  t('aucune fonction d\'annulation ni de remboursement', !w.c.api.emergencyCancel && !w.c.api.cancelExpired);
  const ta = w.tallyAll(1);
  t('comptage terminé', ta.success && w.round(1).status === 'done', ta.error);
  t('solde cohérent', balanceOk(w));
}

// ---------------------------------------------------------------------
sec('Calcul des rangs (' + CAP + ' grilles, recomptage indépendant)');
{
  const w = world();
  const all = [];
  let n = 0;
  while (n < CAP) {
    const who = P[n % 4];
    const g = Array.from({ length: 20 }, () => ref.randomGrid());
    const r = w.buy(who, g); if (!r.success) throw new Error(r.error);
    all.push({ who, g: g.map((x) => [...x].sort((a, b) => a - b)) }); n += 20;
  }
  const dr = w.draw(1);
  t('tirage complet de 150 achats', dr.success, dr.error);
  const rd = w.round(1);
  const cnt = [0, 0, 0];
  for (const p of all) for (const g of p.g) { const k = ref.matches(g, rd.nums); if (k >= 3) cnt[k - 3]++; }
  t('nombre de gagnants à 3/4/5 bons identique au recomptage', JSON.stringify(cnt) === JSON.stringify(rd.cnt), JSON.stringify([cnt, rd.cnt]));
  const kc = w.c.view('getConfig');
  const exp = ref.payouts(rd.sales, rd.price, rd.jackpotIn, rd.cnt, [kc.skimAt || 0, kc.skimAmt || 0]);
  t('gains par rang = calcul de référence (' + rd.cnt.join('/') + ')', JSON.stringify(rd.per) === JSON.stringify(exp.per.map(String)), JSON.stringify([rd.per, exp.per.map(String)]));
  t('report = calcul de référence', rd.carryOut === exp.carry.toString());
  t('4 bons > 3 bons', rd.cnt[1] === 0 || BigInt(rd.per[1]) > BigInt(rd.per[0]));
  // Paiements
  const before = P.map((a) => w.chain.balanceOf(a));
  const pa = w.payAll(1);
  t('paiement par paquets réussi (gas max ' + pa.maxGas + ' < 1 M)', pa.success && pa.maxGas < 1_000_000, pa.error);
  const expected = P.map(() => 0n);
  for (const p of all) for (const g of p.g) { const k = ref.matches(g, rd.nums); if (k >= 3) expected[P.indexOf(p.who)] += BigInt(rd.per[k - 3]); }
  t('chaque joueur a reçu exactement ses gains', P.every((a, i) => w.chain.balanceOf(a) - before[i] === expected[i]));
  t('dettes envers les joueurs = 0 après paiement', w.st().owed === '0');
  t('solde cohérent', balanceOk(w));
}

// ---------------------------------------------------------------------
sec('Commission 15 % : 6 % Airdrop, 9 % équipe 75/25');
{
  const w = world();
  // 7 grilles = 14 ASE → 2,1 ASE de commission → 0,84 Airdrop, 0,945 owner, 0,315 collab
  const bO = w.chain.balanceOf(OWNER_PAY), bC = w.chain.balanceOf(COLLAB), bD = w.chain.balanceOf(DROP);
  w.buy(P[0], Array.from({ length: 7 }, () => ref.randomGrid()));
  t('commission versée dès l\'achat (avant le tirage)', w.chain.balanceOf(DROP) - bD === 840000000000000000n);
  const d = w.draw(1);
  t('tirage OK', d.success, d.error);
  t('owner reçoit 0,945 ASE', w.chain.balanceOf(OWNER_PAY) - bO === 945000000000000000n);
  t('collaborateur reçoit 0,315 ASE', w.chain.balanceOf(COLLAB) - bC === 315000000000000000n);
  t('contrat Airdrop reçoit 0,84 ASE', w.chain.balanceOf(DROP) - bD === 840000000000000000n && w.round(1).airdrop === '840000000000000000');
  t('commission enregistrée = 15 % exact', w.round(1).commission === (21n * ASE / 10n).toString());
  // Montant "tordu" : prix 0,033… pour tester les arrondis
  const w2 = world();
  w2.c.call(ADMIN, 'setConfig', ['33333333333333333', 21, 0, 20, 10, 120]);
  w2.close(1); // tour 1 vide ; le tour 2 prend le nouveau prix
  const bO2 = w2.chain.balanceOf(OWNER_PAY), bC2 = w2.chain.balanceOf(COLLAB), bD2 = w2.chain.balanceOf(DROP);
  w2.c.call(P[0], 'buy', [[[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [3, 4, 5, 6, 7]], ''], 3n * 33333333333333333n);
  const d2 = w2.draw(2);
  t('tirage avec prix non rond OK', d2.success, d2.error);
  const r2 = w2.round(2);
  const S = BigInt(r2.sales), C = BigInt(r2.commission);
  t('commission = floor(15 %)', C === S * 1500n / 10000n);
  t('gains = calcul de référence (prix non rond)', JSON.stringify(r2.per) === JSON.stringify(ref.payouts(r2.sales, r2.price, r2.jackpotIn, r2.cnt).per.map(String)));
  t('owner + collab + Airdrop = commission exacte (aucun wei perdu)', (w2.chain.balanceOf(OWNER_PAY) - bO2) + (w2.chain.balanceOf(COLLAB) - bC2) + (w2.chain.balanceOf(DROP) - bD2) === C);
  t('ventes = commission + gains attribués + report (au wei près)',
    S + BigInt(r2.jackpotIn) === C + BigInt(r2.carryOut) + r2.cnt.reduce((a, n, k) => a + BigInt(n) * BigInt(r2.per[k]), 0n));
  t('solde cohérent', balanceOk(w2));
}

// ---------------------------------------------------------------------
sec('Partage entre gagnants + jackpot (le test "joue à Dieu" : il connaît les 2 secrets)');
{
  const w = world();
  const G = M === 20 ? [2, 7, 11, 13, 17] : [2, 7, 9, 11, 13];
  w.buy(P[0], [G]);
  w.buy(P[1], [G]);
  for (let i = 0; i < 10; i++) w.buy(P[2], [ref.randomGrid()]);
  // Dernier achat : on cherche une graine qui fait sortir G (possible
  // uniquement parce que le test connaît les deux secrets).
  const rd = w.round(1);
  const sO = w.chO[199], sC = w.chC[199];
  let seed = null, i = 0;
  for (; i < 300000; i++) {
    const s = i.toString(16);
    const dg = ref.nextDigest(rd.digest, P[3], [[1, 2, 3, 4, 5]], s, rd.buys);
    if (JSON.stringify(ref.drawNumbers(1, sO, sC, dg)) === JSON.stringify(G)) { seed = s; break; }
  }
  t('graine trouvée (' + i + ' essais)', seed !== null);
  w.buy(P[3], [[1, 2, 3, 4, 5]], seed);
  const d = w.draw(1);
  t('tirage OK', d.success, d.error);
  const r = w.round(1);
  t('numéros sortis = G', JSON.stringify(r.nums) === JSON.stringify(G));
  t('2 gagnants du jackpot', r.cnt[2] === 2);
  const S = BigInt(r.sales);
  t('jackpot partagé à parts égales (35 % / 2)', BigInt(r.per[2]) === (S * 3500n / 10000n) / 2n);
  const b0 = w.chain.balanceOf(P[0]);
  const cl = w.c.call(P[0], 'settle', [1, 0, 1]);
  t('le joueur peut régler son propre achat', cl.success, cl.error);
  t('joueur 1 reçoit sa part', w.chain.balanceOf(P[0]) - b0 === BigInt(r.per[2]));
  const ev = cl.events.find((e) => e.name === 'Paid');
  t('événement Paid : "5 bons", 1 grille gagnante', ev && ev.data.bons === '5' && ev.data.wins === '[0,0,1]' && ev.data.to === P[0], JSON.stringify(ev && ev.data));
  t('double paiement impossible', (() => { const x = w.c.call(P[0], 'settle', [1, 0, 1]); return x.success && x.returnValue.amount === '0'; })());
  t('un perdant ne reçoit rien', (() => { const lo = w.c.view('getPurchases', [1, 0, 50]).find((q) => q.prize === '0'); const b = w.chain.balanceOf(lo.b); const x = w.c.call(P[3], 'settle', [1, lo.idx, 1]); return x.success && x.returnValue.amount === '0' && w.chain.balanceOf(lo.b) === b; })());
  const b1 = w.chain.balanceOf(P[1]);
  t('un tiers peut déclencher le paiement, le gain va à l\'acheteur', w.c.call(P[3], 'settle', [1, 1, 1]).success && w.chain.balanceOf(P[1]) - b1 === BigInt(r.per[2]));
  t('payBatch ne repaie pas les déjà payés', (() => { const x = w.c.call(ADMIN, 'settle', [1, 0, 2]); return x.success && x.returnValue.amount === '0'; })());
  t('solde cohérent', balanceOk(w));
}

// ---------------------------------------------------------------------
sec('Report du jackpot');
{
  const w = world();
  w.buy(P[0], [[1, 2, 3, 4, 5]]);
  // On choisit des tirages SANS gagnant à 5 bons (cas normal).
  w.draw(1);
  const r1 = w.round(1);
  t('pas de gagnant à 5 bons au tour 1', r1.cnt[2] === 0);
  const S1 = PRICE;
  const exp1 = S1 - S1 * 1500n / 10000n - r1.cnt.reduce((a, n, k) => a + BigInt(n) * BigInt(r1.per[k]), 0n);
  t('report = ventes − commission − gains', BigInt(r1.carryOut) === exp1);
  t('jackpot global = report', w.st().jackpot === r1.carryOut);
  w.c.call(P[1], 'buy', [[[6, 7, 8, 9, 10]], ''], PRICE);
  w.draw(2);
  const r2 = w.round(2);
  t('tour 2 : jackpot entrant = report du tour 1', r2.jackpotIn === r1.carryOut);
  // tour 3 vide : le jackpot traverse sans changer
  w.close(3); w.close(4);
  t('tours vides : jackpot inchangé', w.st().jackpot === r2.carryOut);
  t('solde cohérent', balanceOk(w));
}

// ---------------------------------------------------------------------
sec('Pause');
{
  const w = world();
  w.buy(P[0], [[1, 2, 3, 4, 5]]);
  t('pause par l\'admin', w.c.call(ADMIN, 'setPaused', [true]).success);
  t('achat refusé en pause', !w.buy(P[1], [[1, 2, 3, 4, 5]]).success);
  t('le tirage continue en pause (joueurs servis)', w.draw(1).success);
  t('reprise', w.c.call(ADMIN, 'setPaused', [false]).success && w.buy(P[1], [[1, 2, 3, 4, 5]]).success);
  // Pause : le tour en cours est quand même tiré (jamais annulé)
  w.c.call(ADMIN, 'setPaused', [true]);
  t('tour en pause tiré normalement', w.draw(w.st().cur).success);
  t('solde cohérent', balanceOk(w));
}

// ---------------------------------------------------------------------
sec('Accès admin refusé aux autres');
{
  const w = world();
  for (const [m, a] of [['setPaused', [true]], ['setConfig', ['1000000000000000000', 20, 0, 5, 5, 60]],
    ['setPayouts', [P[0], P[0]]], ['setAdmin', [P[0]]], ['setTipOwner', ['a'.repeat(64)]]]) {
    t(`${m} refusé à un joueur`, !w.c.call(P[0], m, a).success);
  }
  for (const bad of [['1', 21, 0, 20, 10, 120], ['2000000000000000000', 5, 0, 20, 10, 120], ['2000000000000000000', 21, 60, 20, 10, 120], ['2000000000000000000', 21, 0, 51, 10, 120], ['2000000000000000000', 21, 0, 20, 1, 120], ['2000000000000000000', 21, 0, 20, 10, 20]])
    t('setConfig hors bornes refusé ' + JSON.stringify(bad), !w.c.call(ADMIN, 'setConfig', bad).success);
  t('setConfig valide accepté', w.c.call(ADMIN, 'setConfig', ['3000000000000000000', 20, 15, 10, 15, 90]).success && w.c.view('getConfig').maxGrids === 10);
  t('setConfig sans plafond par tirage : inchangé', w.c.view('getConfig').maxRound === CAP);
  const CAP2 = M === 20 ? 5000 : 1200;
  t('setConfig avec plafond par tirage', w.c.call(ADMIN, 'setConfig', ['3000000000000000000', 20, 15, 10, 15, 90, CAP2]).success && w.c.view('getConfig').maxRound === CAP2);
  if (M < 20) t('plafond par tirage trop haut refusé (jamais toutes les combinaisons)', !w.c.call(ADMIN, 'setConfig', ['3000000000000000000', 20, 15, 10, 15, 90, M === 15 ? 1000001 : 2002]).success);
  t('plafond par tirage < grilles par achat refusé', !w.c.call(ADMIN, 'setConfig', ['3000000000000000000', 20, 15, 10, 15, 90, 5]).success);
  t('setTipCollab refusé à l\'admin', !w.c.call(ADMIN, 'setTipCollab', ['b'.repeat(64)]).success);
  t('aucune fonction de retrait n\'existe', !Object.keys(w.c.api).some((k) => /withdraw|sweep|drain|rescue/i.test(k)));
  t('ASE joint à un appel non payant refusé', !w.c.call(P[0], 'poke', [], 1n).success);
}

// ---------------------------------------------------------------------
sec('Secret en retard : le tirage attend, jamais d\'annulation');
{
  const w = world();
  w.buy(P[0], [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]);
  w.buy(P[1], [[1, 2, 3, 4, 6]]);
  w.close(1);
  t('owner révèle', w.revealO(1).success);
  w.chain.mineUntil(w.round(1).closeTs + 3 * 86400000);   // le collaborateur a 3 jours de retard…
  w.c.call(P[3], 'poke');
  t('le tour attend toujours (statut closed)', w.round(1).status === 'closed');
  t('les ventes continuent sur les tours suivants', w.buy(P[2], [[1, 2, 3, 4, 5]]).success);
  t('le collaborateur révèle enfin : tirage normal', w.revealC(1).success && w.tallyAll(1).success && w.round(1).status === 'done');
  t('remboursement impossible (settle refusé sur un tour non tiré)', !w.c.call(P[0], 'settle', [2, 0, 1]).success || w.round(2).status === 'done');
  t('solde cohérent', balanceOk(w));
}

// ---------------------------------------------------------------------
sec('Attaque "grille de dernière minute"');
{
  // L'owner connaît SON secret mais pas celui du collaborateur.
  const w = world();
  for (let i = 0; i < 6; i++) w.buy(P[i % 3], [ref.randomGrid()]);
  const rd = w.round(1);
  const sO = w.chO[199];
  // Il "prédit" avec un secret collab inventé et achète la grille prédite.
  const fake = ref.makeChain(1)[0];
  const dg = ref.nextDigest(rd.digest, P[3], [[1, 2, 3, 4, 5]], 'ff', rd.buys);
  const predicted = ref.drawNumbers(1, sO, fake, dg);
  w.buy(P[3], [predicted], 'ff');
  w.draw(1);
  t('sans le secret du collaborateur, la prédiction échoue', JSON.stringify(w.round(1).nums) !== JSON.stringify(predicted));
  // Achat après la fermeture : part dans le tour suivant, ne change pas le tirage du tour 1.
  const w2 = world();
  w2.buy(P[0], [ref.randomGrid()]);
  const before = w2.round(1).digest;
  w2.chain.mineUntil(w2.round(1).closeTs);
  w2.buy(P[3], [[1, 2, 3, 4, 5]], 'ee');
  t('achat après fermeture n\'entre pas dans le tour fermé', w2.round(1).digest === before && w2.round(1).buys === 1);
  t('révélation impossible avant fermeture (rien à exploiter)', (() => { const w3 = world(); w3.buy(P[0], [[1, 2, 3, 4, 5]]); return !w3.revealO(1).success; })());
}

// ---------------------------------------------------------------------
sec('Heure de Paris et changement d\'heure');
{
  // Été : 21:00 Paris = 19:00 UTC ; hiver : 20:00 UTC. Fin de l'heure d'été : 25/10/2026.
  const w = world({ start: Date.UTC(2026, 9, 23, 12) });
  let id = 1;
  const seen = [];
  for (let i = 0; i < 6; i++) { const r = w.round(id); seen.push(new Date(r.drawTs).toISOString().slice(0, 16)); w.close(id); id++; }
  t('23/10 → 19:00 UTC', seen[0] === '2026-10-23T19:00');
  t('24/10 → 19:00 UTC', seen[1] === '2026-10-24T19:00');
  t('25/10 (passage à l\'heure d\'hiver) → 20:00 UTC', seen[2] === '2026-10-25T20:00', seen[2]);
  t('26/10 → 20:00 UTC', seen[3] === '2026-10-26T20:00');
  const all21 = seen.every((s) => ref.parisHM(Date.parse(s + ':00Z')) === '21:00');
  t('toujours 21:00 à Paris', all21, seen.join(' '));
  const w2 = world({ start: Date.UTC(2027, 2, 27, 12) });
  const s2 = [];
  for (let i = 0, id2 = 1; i < 3; i++, id2++) { s2.push(new Date(w2.round(id2).drawTs).toISOString().slice(0, 16)); w2.close(id2); }
  t('28/03/2027 (passage à l\'heure d\'été) → 19:00 UTC', s2[1] === '2027-03-28T19:00', s2.join(' '));
  // Changement d'horaire par l'admin : tout de suite si le tour est vide…
  const w3 = world();
  w3.c.call(ADMIN, 'setConfig', ['3000000000000000000', 16, 0, 20, 10, 120]);
  t('tour vide : horaire appliqué tout de suite (16:00 le jour même)', ref.parisHM(w3.round(1).drawTs) === '16:00' && new Date(w3.round(1).drawTs).toISOString().startsWith('2026-10-10T14:00'), new Date(w3.round(1).drawTs).toISOString());
  t('tour vide : fermeture à 15:50 et nouveau prix', ref.parisHM(w3.round(1).closeTs) === '15:50' && w3.round(1).price === '3000000000000000000');
  t('toujours le tour n°1', w3.st().cur === 1);
  // …sinon au tour suivant
  w3.buy(P[0], [[1, 2, 3, 4, 5]], '');
  t('achat au nouveau prix', w3.c.call(P[1], 'buy', [[[1, 2, 3, 4, 5]], ''], 3n * ASE).success);
  w3.c.call(ADMIN, 'setConfig', ['2000000000000000000', 20, 30, 20, 10, 120]);
  t('tour déjà joué : inchangé', ref.parisHM(w3.round(1).drawTs) === '16:00' && w3.round(1).price === '3000000000000000000');
  w3.close(1);
  t('tour suivant à 20:30', ref.parisHM(w3.round(2).drawTs) === '20:30');
  // Réglage trop proche (fermeture déjà passée aujourd'hui) → lendemain
  const w4 = world({ start: Date.UTC(2026, 9, 10, 13, 55) });  // 15:55 Paris
  w4.c.call(ADMIN, 'setConfig', ['2000000000000000000', 16, 0, 20, 10, 120]);
  t('16:00 demandé à 15:55 → lendemain 16:00', new Date(w4.round(1).drawTs).toISOString().startsWith('2026-10-11T14:00'), new Date(w4.round(1).drawTs).toISOString());
}

// ---------------------------------------------------------------------
// Trouve une graine pour le dernier achat qui fait sortir G (le test connaît les 2 secrets).
function forceDraw(w, id, G, buyer, grid) {
  const rd = w.round(id);
  const sO = ref.preimageOf(w.chO, w.st().tipO), sC = ref.preimageOf(w.chC, w.st().tipC);
  for (let i = 0; i < 2000000; i++) {
    const s = i.toString(16);
    const dg = ref.nextDigest(rd.digest, buyer, [grid], s, rd.buys);
    if (JSON.stringify(ref.drawNumbers(id, sO, sC, dg)) === JSON.stringify(G)) return w.buy(buyer, [grid], s);
  }
  throw new Error('graine introuvable');
}
const G = M === 20 ? [2, 7, 11, 13, 17] : [2, 7, 9, 11, 13];
const per = (w, id) => w.round(id).per.map(BigInt);

sec('Gains fixes + bonus (pas de jackpot gagné)');
{
  const w = world();
  // 100 grilles : 1 à 4 bons, 9 à 3 bons, le reste perdant (≤ 1 bon)
  w.buy(P[0], [[2, 7, 11, 13, 1]]);
  for (let i = 0; i < 9; i++) t('achat 3 bons', w.buy(P[1], [i % 2 ? [2, 7, 11, 4, 6] : [2, 7, 11, 3, 5]]).success);
  const losers = [[1, 3, 4, 5, 6], [1, 3, 4, 5, 8], [1, 3, 4, 6, 8], [3, 4, 5, 6, 8], [1, 4, 5, 6, 8]];
  for (let i = 0; i < 89; i++) w.buy(P[2], [losers[i % 5]]);
  forceDraw(w, 1, G, P[3], [1, 3, 4, 5, 6]);
  const d = w.draw(1);
  t('tirage OK', d.success, d.error);
  const r = w.round(1);
  t('100 grilles, gagnants 9 / 1 / 0', r.grids === 100 && JSON.stringify(r.cnt) === '[9,1,0]', JSON.stringify(r.cnt));
  const [g3, g4] = per(w, 1);
  // 100 grilles à 2 ASE = 200 ASE, 1 × 4 bons, 9 × 3 bons, pas de jackpot
  t('4 bons = 68,42 ASE (50 + bonus)', g4 / 10n ** 16n === 6842n, String(g4));
  t('3 bons = 6,84 ASE (5 + bonus)', g3 / 10n ** 16n === 684n, String(g3));
  t('4 bons = 10 × 3 bons (bonus au prorata)', g4 / g3 === 10n);
  t('report = 40 ASE (moitié de la part jackpot + reste de la caisse) + poussière', BigInt(r.carryOut) - 40n * ASE < 1000n && r.carryOut === ref.payouts(r.sales, r.price, r.jackpotIn, r.cnt).carry.toString(), r.carryOut);
  const b = w.chain.balanceOf(P[0]);
  const pa = w.payAll(1);
  t('paiement automatique de tous les gagnants', pa.success && w.st().owed === '0');
  t('le 4 bons a reçu son gain sans rien faire', w.chain.balanceOf(P[0]) - b === g4);
  t('solde cohérent', balanceOk(w));
}

sec('Caisse insuffisante + petit jackpot (ordre 5 > 4 > 3 garanti)');
{
  const w = world();
  // 5 grilles seulement : 1 × 5 bons, 2 × 4 bons, 1 × 3 bons → caisse des gains fixes trop petite
  w.buy(P[0], [G]);
  w.buy(P[1], [[2, 7, 11, 13, 1], [2, 7, 11, 13, 3]]);
  w.buy(P[2], [[2, 7, 11, 4, 5]]);
  forceDraw(w, 1, G, P[3], [1, 3, 4, 5, 6]);
  const d = w.draw(1);
  t('tirage OK', d.success, d.error);
  const r = w.round(1);
  t('gagnants 1 / 2 / 1', JSON.stringify(r.cnt) === '[1,2,1]', JSON.stringify(r.cnt));
  const [g3, g4, g5] = per(w, 1);
  t('= calcul de référence', JSON.stringify(r.per) === JSON.stringify(ref.payouts(r.sales, r.price, r.jackpotIn, r.cnt).per.map(String)));
  t('5 bons > 4 bons > 3 bons', g5 > g4 && g4 > g3 && g3 > 0n, [g3, g4, g5].join(' '));
  t('4 bons ≤ 80 % du 5 bons', g4 * 5n <= g5 * 4n);
  const pa = w.payAll(1);
  t('tout est payé, rien n\'est promis en trop', pa.success && w.st().owed === '0' && balanceOk(w));
  const ev = w.c.call(ADMIN, 'settle', [1, 0, 5]);
  t('rien à repayer', ev.success && ev.returnValue.amount === '0');
}

sec('Jackpot gagné avec report');
{
  const w = world();
  for (let i = 0; i < 20; i++) w.buy(P[0], [[1, 3, 4, 5, 6]]);
  forceDraw(w, 1, G, P[3], [1, 3, 4, 5, 6]);   // aucune grille gagnante
  w.draw(1);
  const carry1 = BigInt(w.round(1).carryOut);
  t('tour 1 sans gagnant : tout est reporté sauf la commission (42 ASE × 85 %)', carry1 === 357n * ASE / 10n, String(carry1));
  w.buy(P[1], [G]);
  forceDraw(w, 2, G, P[3], [1, 3, 4, 5, 6]);
  w.draw(2);
  const r = w.round(2);
  t('jackpot entrant = report du tour 1', r.jackpotIn === carry1.toString());
  t('gagnant du jackpot : 35 % du tour + report', BigInt(r.per[2]) === (2n * PRICE * 35n / 100n) + carry1, r.per[2]);
  t('= calcul de référence', JSON.stringify(r.per) === JSON.stringify(ref.payouts(r.sales, r.price, r.jackpotIn, r.cnt).per.map(String)));
  t('solde cohérent', balanceOk(w));
}

sec('Plafond de grilles par tirage');
{
  const w = world();
  w.c.call(ADMIN, 'setConfig', [PRICE.toString(), 21, 0, 20, 10, 120, 30]);
  t('20 grilles OK', w.buy(P[0], Array.from({ length: 20 }, () => ref.randomGrid())).success);
  t('10 de plus OK (30 = plafond)', w.buy(P[1], Array.from({ length: 10 }, () => ref.randomGrid())).success);
  const x = w.buy(P[2], [ref.randomGrid()]);
  t('31e grille refusée : tirage complet', !x.success && /draw full/.test(x.error), x.error);
  w.close(1);
  t('le tirage suivant est rouvert', w.buy(P[2], [ref.randomGrid()]).success && w.round(2).grids === 1);
}

// ---------------------------------------------------------------------
sec('Prélèvement maison (v5) : jackpot non gagné > 70 ASE → 20 ASE au wallet owner');
{
  const has = !!world().c.view('getConfig').skimAt;
  if (!has) {
    console.log('  (contrat sans prélèvement maison)');
    const f = world();
    t('aucune fonction de prélèvement (setSkim absent)', !f.c.api.setSkim);
    t('fund refusé sans ASE', !f.c.call(P[0], 'fund', [], 0n).success);
    t('fund ajoute 100 ASE au jackpot', f.c.call(P[0], 'fund', [], 100n * ASE).success && f.st().jackpot === (100n * ASE).toString());
    f.buy(P[1], [ref.randomGrid()]);
    const ob = f.chain.balanceOf(OWNER_PAY);
    f.draw(1);
    const r1 = f.round(1);
    if (r1.cnt[2] === 0) t('jackpot non gagné : tout est reporté, rien pour l\'owner au tirage', BigInt(r1.carryOut) > 100n * ASE && f.chain.balanceOf(OWNER_PAY) === ob);
    t('solde cohérent (fund)', balanceOk(f));
  }
  else {
    const A70 = 70n * ASE, A20 = 20n * ASE;
    // Gros tirage : 100 grilles à 2 ASE → report > 70 ASE
    const w = world();
    t('réglage par défaut : 70 / 20 ASE', w.c.view('getConfig').skimAt === A70.toString() && w.c.view('getConfig').skimAmt === A20.toString());
    w.c.call(P[3], 'fund', [], 80n * ASE);   // jackpot de départ 80 ASE : le report dépassera forcément 70
    for (let k = 0; k < 5; k++) w.buy(P[k % 3], Array.from({ length: 20 }, () => ref.randomGrid()));
    // attendre la fermeture, puis mesurer le wallet owner pendant le tirage seulement
    w.close(1); w.revealO(1); w.revealC(1);
    const ob = w.chain.balanceOf(OWNER_PAY);
    const ta = w.tallyAll(1);
    const r = w.round(1);
    const exp = ref.payouts(r.sales, r.price, r.jackpotIn, r.cnt, [A70, A20]);
    t('tirage OK', ta.success, ta.error);
    if (r.cnt[2] === 0) {
      t('20 ASE prélevés (report brut ' + ((exp.carry + exp.skim) / ASE) + ' ASE > 70)', r.skim === A20.toString() && exp.skim === A20);
      t('report = brut − 20 ASE', r.carryOut === exp.carry.toString() && w.st().jackpot === r.carryOut);
      t('le wallet owner reçoit 20 ASE au tirage', w.chain.balanceOf(OWNER_PAY) - ob === A20);
      t('événement Finalized avec skim', ta.events.some((e) => e.name === 'Finalized' && e.data.skim === A20.toString()));
    }
    t('solde cohérent', balanceOk(w));
    // Tirage suivant : le report repasse au-dessus de 70 ? → encore 20 ASE, sinon rien
    for (let k = 0; k < 2; k++) w.buy(P[k], Array.from({ length: 20 }, () => ref.randomGrid()));
    const ob2 = w.chain.balanceOf(OWNER_PAY);
    w.close(2); w.revealO(2); w.revealC(2); w.tallyAll(2);
    const r2 = w.round(2), e2 = ref.payouts(r2.sales, r2.price, r2.jackpotIn, r2.cnt, [A70, A20]);
    t('tirage 2 : prélèvement seulement si report > 70 (' + (e2.skim / ASE) + ' ASE)', r2.skim === e2.skim.toString() && r2.carryOut === e2.carry.toString() && w.chain.balanceOf(OWNER_PAY) - ob2 === e2.skim);
    t('solde cohérent (2)', balanceOk(w));

    // Petit tirage : report < 70 → rien
    const s = world();
    s.buy(P[0], [ref.randomGrid(), ref.randomGrid()]);
    const sb = s.chain.balanceOf(OWNER_PAY);
    s.draw(1);
    t('report sous 70 ASE : aucun prélèvement', s.round(1).skim === '0' && s.chain.balanceOf(OWNER_PAY) === sb);

    // fund : ajout au jackpot, puis prélèvement au tirage
    const f = world();
    t('fund refusé sans ASE', !f.c.call(P[0], 'fund', [], 0n).success);
    const fr = f.c.call(P[0], 'fund', [], 100n * ASE);
    t('fund ajoute 100 ASE au jackpot', fr.success && f.st().jackpot === (100n * ASE).toString(), fr.error);
    t('jackpot affiché inclut le fund', BigInt(f.c.view('info').jackpotEstimate) >= 100n * ASE);
    f.buy(P[1], [ref.randomGrid()]);
    const fb = f.chain.balanceOf(OWNER_PAY);
    f.draw(1);
    const fr1 = f.round(1);
    if (fr1.cnt[2] === 0) t('jackpot 100+ ASE non gagné → 20 ASE prélevés', fr1.skim === A20.toString() && f.chain.balanceOf(OWNER_PAY) - fb === A20);
    t('solde cohérent (fund)', balanceOk(f));

    // Réglage par l'admin
    const g = world();
    t('setSkim refusé à un joueur', !g.c.call(P[0], 'setSkim', [A70.toString(), A20.toString()]).success);
    t('montant > seuil refusé', !g.c.call(ADMIN, 'setSkim', [A20.toString(), A70.toString()]).success);
    t('setSkim 0 = désactivé', g.c.call(ADMIN, 'setSkim', [A70.toString(), '0']).success);
    g.c.call(P[0], 'fund', [], 100n * ASE); g.buy(P[1], [ref.randomGrid()]); g.draw(1);
    t('désactivé : aucun prélèvement', g.round(1).skim === '0' && BigInt(g.st().jackpot) > 100n * ASE);
  }
}

if (M === 15) {
  sec('v7 : 15 numéros, 15 grilles par wallet et par tirage');
  const w = world({ raw: true });
  w.c.call(ADMIN, 'setConfig', [PRICE.toString(), 21, 0, 15, 60, 120, 2000]);   // sans 8e argument : limite par wallet inchangée
  const grids = (n) => Array.from({ length: n }, (_, k) => [1 + (k % 11), 2 + (k % 11), 3 + (k % 11), 4 + (k % 11), 15]);
  t('numéro 15 accepté, 16 refusé', w.buy(P[0], [[1, 2, 3, 4, 15]]).success && !w.buy(P[0], [[1, 2, 3, 4, 16]]).success);
  t('14 de plus (total 15) OK', w.buy(P[0], grids(14)).success && w.c.view('getWallet', [1, P[0]]) === 15);
  const x = w.buy(P[0], grids(1));
  t('16e grille refusée (15 max par wallet)', !x.success && /max 15 tickets per wallet/.test(x.error), x.error);
  t('un autre wallet peut jouer', w.buy(P[1], grids(15)).success);
  t('admin : limite par wallet à 20, tout de suite', w.c.call(ADMIN, 'setConfig', [PRICE.toString(), 21, 0, 15, 60, 120, 2000, 20]).success && w.buy(P[0], grids(5)).success && !w.buy(P[0], grids(1)).success);
  t('limite par wallet hors bornes refusée', !w.c.call(ADMIN, 'setConfig', [PRICE.toString(), 21, 0, 15, 60, 120, 2000, 0]).success);
  t('info : limite par wallet visible', w.c.view('info').maxWallet === 20);
  const d = w.draw(1);
  t('tirage OK, numéros dans 1..16', d.success && w.round(1).nums.every((n) => n >= 1 && n <= 15), d.error);
  t('compteur remis à zéro au tirage suivant', w.c.view('getWallet', [2, P[0]]) === 0 && w.buy(P[0], grids(15)).success);

  sec('v7 : nombre de numéros et plafond par tirage réglables');
  const v = world({ raw: true });
  const cfgA = (mr, wl, n) => [PRICE.toString(), 21, 0, 15, 60, 120, mr, wl, n];
  t('plafond par tirage à 100 000 accepté (pas de vraie limite)', v.c.call(ADMIN, 'setConfig', cfgA(100000, 15)).success && v.c.view('getConfig').maxRound === 100000);
  t('tour vide : passage à 20 numéros tout de suite', v.c.call(ADMIN, 'setConfig', cfgA(100000, 15, 20)).success && v.round(1).maxn === 20 && v.c.view('info').maxn === 20);
  t('numéro 20 accepté', v.buy(P[0], [[1, 2, 3, 4, 20]]).success);
  t('tour commencé : passage à 10 numéros pour le tirage suivant seulement', v.c.call(ADMIN, 'setConfig', cfgA(100000, 15, 10)).success && v.round(1).maxn === 20 && v.c.view('info').nextMaxn === 10 && v.buy(P[1], [[16, 17, 18, 19, 20]]).success);
  const d1 = v.draw(1);
  t('tirage n°1 sur 1..20', d1.success && v.round(1).nums.every((n) => n >= 1 && n <= 20), d1.error);
  t('tirage n°2 en 1..10 : 11 refusé, 10 accepté', v.round(2).maxn === 10 && !v.buy(P[0], [[1, 2, 3, 4, 11]]).success && v.buy(P[0], [[1, 2, 3, 4, 10]]).success);
  const d2 = v.draw(2);
  t('tirage n°2 sur 1..10', d2.success && v.round(2).nums.every((n) => n >= 1 && n <= 10), d2.error);
  t('5 numéros ou moins refusé, 100 refusé, 99 accepté', !v.c.call(ADMIN, 'setConfig', cfgA(100000, 15, 5)).success && !v.c.call(ADMIN, 'setConfig', cfgA(100000, 15, 100)).success && v.c.call(ADMIN, 'setConfig', cfgA(100000, 15, 99)).success);
  t('sans 9e argument : nombre de numéros inchangé', v.c.call(ADMIN, 'setConfig', cfgA(100000, 15)).success && v.c.view('getConfig').maxn === 99);
}

console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
