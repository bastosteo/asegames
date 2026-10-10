// Tests automatisés du contrat loto : node contrat/loto.test.mjs
import { readFileSync } from 'node:fs';
import { Chain } from '../sim/vm-sim.mjs';
import * as ref from './ref.mjs';

const SRC = readFileSync(new URL('./loto.js', import.meta.url), 'utf8');
const ASE = 10n ** 18n;
const PRICE = 2n * ASE;

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
const P = ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40), '0x' + '3'.repeat(40), '0x' + '4'.repeat(40)];

// Un monde neuf : chaîne simulée + contrat déployé + initialisé.
// Départ : samedi 10/10/2026 12:00 UTC (14h00 à Paris).
function world({ start = Date.UTC(2026, 9, 10, 12, 0) } = {}) {
  const chain = new Chain({ startTimestampMs: start, blockTimeMs: 8000 });
  for (const a of [ADMIN, OWNER_PAY, COLLAB, ...P]) chain.fund(a, 100000n * ASE);
  const c = chain.deploy(SRC, ADMIN);
  const chO = ref.makeChain(200), chC = ref.makeChain(200);
  const r = c.call(ADMIN, 'init', [OWNER_PAY, COLLAB, COLLAB, chO[200], chC[200]]);
  if (!r.success) throw new Error('init: ' + r.error);
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
        if (['open', 'closed', 'tally'].includes(r.status)) pend += BigInt(r.sales);
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
  const w = world();
  const cfg = w.c.view('getConfig');
  t('admin = déployeur', cfg.admin === ADMIN);
  t('prix 2 ASE', cfg.price === PRICE.toString());
  t('double init refusé', !w.c.call(ADMIN, 'init', [OWNER_PAY, COLLAB, COLLAB, w.chO[200], w.chC[200]]).success);
  const r1 = w.round(1);
  t('tour 1 ouvert', r1.status === 'open');
  t('tirage à 21:00 heure de Paris', ref.parisHM(r1.drawTs) === '21:00', ref.parisHM(r1.drawTs));
  t('fermeture à 20:50 heure de Paris', ref.parisHM(r1.closeTs) === '20:50', ref.parisHM(r1.closeTs));
  t('tirage le jour même (10/10)', new Date(r1.drawTs).toISOString().startsWith('2026-10-10T19:00'), new Date(r1.drawTs).toISOString());

  // Le contrat n'accepte que des adresses 0x (le site, le croupier et le guide convertissent les ase1).
  const chain3 = new Chain(); chain3.fund(ADMIN, ASE);
  const c3 = chain3.deploy(SRC, ADMIN);
  t('adresse ase1 refusée par le contrat (conversion avant envoi)', !c3.call(ADMIN, 'init', ['ase1hypqm76acwd7lwvfsh396psdd5fm8zf35pjupv', COLLAB, COLLAB, w.chO[5], w.chC[5]]).success);
  t('adresse 0x en majuscules acceptée et normalisée', (() => { const ch = new Chain(); ch.fund(ADMIN, ASE); const k = ch.deploy(SRC, ADMIN); const r = k.call(ADMIN, 'init', ['0xB9020DFB5DC39BEFB98985E25D060D6D13B38931', COLLAB, COLLAB, w.chO[5], w.chC[5]]); return r.success && k.view('getConfig').payOwner === '0xb9020dfb5dc39befb98985e25d060d6d13b38931'; })());
}

// ---------------------------------------------------------------------
sec('Achat');
{
  const w = world();
  let r = w.buy(P[0], [[5, 3, 1, 2, 4], [18, 17, 16, 15, 14]], 'abcd');
  t('achat de 2 grilles réussi', r.success, r.error);
  const pur = w.c.view('getPurchases', [1, 0, 10]);
  t('grilles triées et enregistrées', JSON.stringify(pur[0].g) === '[[1,2,3,4,5],[14,15,16,17,18]]');
  t('acheteur enregistré', pur[0].b === P[0]);
  t('événement Buy émis (avec la graine)', r.events.some((e) => e.name === 'Buy' && e.data.grids === '[[1,2,3,4,5],[14,15,16,17,18]]' && e.data.seed === 'abcd'));
  t('contrat a reçu 4 ASE', w.chain.balanceOf(w.c.address) === 4n * ASE);
  const rd = w.round(1);
  t('ventes du tour = 4 ASE, 2 grilles, 1 achat', rd.sales === (4n * ASE).toString() && rd.grids === 2 && rd.buys === 1);
  let d = ref.nextDigest(ref.initialDigest(1), P[0], [[1, 2, 3, 4, 5], [14, 15, 16, 17, 18]], 'abcd', 0);
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
  bad('numéro 19 refusé', [[1, 2, 3, 4, 19]]);
  bad('numéro décimal refusé', [[1.5, 2, 3, 4, 5]]);
  bad('texte refusé', [['a', 2, 3, 4, 5]]);
  bad('4 numéros refusés', [[1, 2, 3, 4]]);
  bad('6 numéros refusés', [[1, 2, 3, 4, 5, 6]]);
  bad('aucune grille refusée', []);
  bad('montant insuffisant refusé', [[1, 2, 3, 4, 5]], PRICE - 1n);
  bad('montant en trop refusé', [[1, 2, 3, 4, 5]], PRICE + 1n);
  bad('21 grilles refusées (plafond 20)', Array.from({ length: 21 }, () => [1, 2, 3, 4, 5]));
  t('rien encaissé après tous ces refus', w.chain.balanceOf(w.c.address) === 0n);
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
  t('5 numéros distincts entre 1 et 18', rd.nums.length === 5 && new Set(rd.nums).size === 5 && rd.nums.every((n) => n >= 1 && n <= 18));
    t('statut "tally"', rd.status === 'tally');
  t('pas d\'annulation d\'urgence après révélation', !w.c.call(ADMIN, 'emergencyCancel', [1]).success);
  t('pas d\'annulation pour délai après révélation complète', !w.c.call(P[0], 'cancelExpired', [1]).success);
  const ta = w.tallyAll(1);
  t('comptage terminé', ta.success && w.round(1).status === 'done', ta.error);
  t('solde cohérent', balanceOk(w));
}

// ---------------------------------------------------------------------
sec('Calcul des rangs (3 000 grilles, recomptage indépendant)');
{
  const w = world();
  const all = [];
  let n = 0;
  while (n < 3000) {
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
  const S = BigInt(rd.sales);
  t('gain par gagnant à 3 bons = 35 % / nb gagnants', cnt[0] === 0 || BigInt(rd.per[0]) === (S * 3500n / 10000n) / BigInt(cnt[0]));
  t('gain par gagnant à 4 bons = 20 % / nb gagnants', cnt[1] === 0 || BigInt(rd.per[1]) === (S * 2000n / 10000n) / BigInt(cnt[1]));
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
sec('Commission 5 % et partage 80/20 exacts');
{
  const w = world();
  // 7 grilles = 14 ASE → 0,7 ASE de commission → 0,56 owner / 0,14 collab
  w.buy(P[0], Array.from({ length: 7 }, () => ref.randomGrid()));
  const bO = w.chain.balanceOf(OWNER_PAY), bC = w.chain.balanceOf(COLLAB);
  const d = w.draw(1);
  t('tirage OK', d.success, d.error);
  t('owner reçoit 0,56 ASE', w.chain.balanceOf(OWNER_PAY) - bO === 560000000000000000n);
  t('collaborateur reçoit 0,14 ASE (il paie aussi le gas de ses appels en vrai)', w.chain.balanceOf(COLLAB) - bC === 140000000000000000n);
  t('commission enregistrée = 5 % exact', w.round(1).commission === '700000000000000000');
  // Montant "tordu" : prix 0,033… pour tester les arrondis
  const w2 = world();
  w2.c.call(ADMIN, 'setConfig', ['33333333333333333', 21, 0, 20, 10, 120]);
  w2.close(1); // tour 1 vide ; le tour 2 prend le nouveau prix
  w2.c.call(P[0], 'buy', [[[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [3, 4, 5, 6, 7]], ''], 3n * 33333333333333333n);
  const bO2 = w2.chain.balanceOf(OWNER_PAY), bC2 = w2.chain.balanceOf(COLLAB);
  const d2 = w2.draw(2);
  t('tirage avec prix non rond OK', d2.success, d2.error);
  const r2 = w2.round(2);
  const S = BigInt(r2.sales), C = BigInt(r2.commission);
  t('commission = floor(5 %)', C === S * 500n / 10000n);
  t('owner + collab = commission exacte (aucun wei perdu)', (w2.chain.balanceOf(OWNER_PAY) - bO2) + (w2.chain.balanceOf(COLLAB) - bC2) === C);
  t('ventes = commission + gains attribués + report (au wei près)',
    S + BigInt(r2.jackpotIn) === C + BigInt(r2.carryOut) + r2.cnt.reduce((a, n, k) => a + BigInt(n) * BigInt(r2.per[k]), 0n));
  t('solde cohérent', balanceOk(w2));
}

// ---------------------------------------------------------------------
sec('Partage entre gagnants + jackpot (le test "joue à Dieu" : il connaît les 2 secrets)');
{
  const w = world();
  const G = [2, 7, 11, 13, 17];
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
  const pj = S * 4000n / 10000n + (S - S * 500n / 10000n - S * 4000n / 10000n - S * 2000n / 10000n - S * 3500n / 10000n);
  t('jackpot partagé à parts égales', BigInt(r.per[2]) === pj / 2n);
  const b0 = w.chain.balanceOf(P[0]);
  const cl = w.c.call(P[0], 'claim', [1, 0]);
  t('claim du joueur 1 OK', cl.success, cl.error);
  t('joueur 1 reçoit sa part', w.chain.balanceOf(P[0]) - b0 === BigInt(r.per[2]));
  t('double claim refusé', !w.c.call(P[0], 'claim', [1, 0]).success);
  t('claim d\'un perdant refusé', !w.c.call(P[2], 'claim', [1, 2]).success || w.c.view('getPurchases', [1, 2, 1])[0].prize !== '0');
  const b1 = w.chain.balanceOf(P[1]);
  t('un tiers peut déclencher le claim, le gain va à l\'acheteur', w.c.call(P[3], 'claim', [1, 1]).success && w.chain.balanceOf(P[1]) - b1 === BigInt(r.per[2]));
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
  const S1 = 2n * ASE;
  const exp1 = S1 - S1 * 500n / 10000n - r1.cnt.reduce((a, n, k) => a + BigInt(n) * BigInt(r1.per[k]), 0n);
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
  // Pause + annulation d'urgence avec remboursement
  w.c.call(ADMIN, 'setPaused', [true]);
  const cur = w.st().cur;
  t('annulation d\'urgence du tour ouvert', w.c.call(ADMIN, 'emergencyCancel', [cur]).success);
  const b = w.chain.balanceOf(P[1]);
  t('remboursement 100 %', w.c.call(P[1], 'claim', [cur, 0]).success && w.chain.balanceOf(P[1]) - b === PRICE);
  t('solde cohérent', balanceOk(w));
}

// ---------------------------------------------------------------------
sec('Accès admin refusé aux autres');
{
  const w = world();
  for (const [m, a] of [['setPaused', [true]], ['setConfig', ['1000000000000000000', 20, 0, 5, 5, 60]],
    ['setPayouts', [P[0], P[0]]], ['setAdmin', [P[0]]], ['emergencyCancel', [1]], ['setTipOwner', ['a'.repeat(64)]]]) {
    t(`${m} refusé à un joueur`, !w.c.call(P[0], m, a).success);
  }
  for (const bad of [['1', 21, 0, 20, 10, 120], ['2000000000000000000', 5, 0, 20, 10, 120], ['2000000000000000000', 21, 60, 20, 10, 120], ['2000000000000000000', 21, 0, 51, 10, 120], ['2000000000000000000', 21, 0, 20, 1, 120], ['2000000000000000000', 21, 0, 20, 10, 20]])
    t('setConfig hors bornes refusé ' + JSON.stringify(bad), !w.c.call(ADMIN, 'setConfig', bad).success);
  t('setConfig valide accepté', w.c.call(ADMIN, 'setConfig', ['3000000000000000000', 20, 15, 10, 15, 90]).success && w.c.view('getConfig').maxGrids === 10);
  t('setTipCollab refusé à l\'admin', !w.c.call(ADMIN, 'setTipCollab', ['b'.repeat(64)]).success);
  t('aucune fonction de retrait n\'existe', !Object.keys(w.c.api).some((k) => /withdraw|sweep|drain|rescue/i.test(k)));
  t('ASE joint à un appel non payant refusé', !w.c.call(P[0], 'poke', [], 1n).success);
}

// ---------------------------------------------------------------------
sec('Pas de révélation → annulation et remboursement');
{
  const w = world();
  w.buy(P[0], [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]);
  w.buy(P[1], [[1, 2, 3, 4, 6]]);
  w.close(1);
  t('owner révèle', w.revealO(1).success);
  // le collaborateur ne révèle pas…
  t('annulation refusée avant le délai', !w.c.call(P[2], 'cancelExpired', [1]).success);
  w.chain.mineUntil(w.round(1).closeTs + 120 * 60000);
  t('collab trop tard : refusé', !w.revealC(1).success);
  t('n\'importe quel joueur peut annuler après 2 h', w.c.call(P[2], 'cancelExpired', [1]).success);
  const b0 = w.chain.balanceOf(P[0]), b1 = w.chain.balanceOf(P[1]);
  const rb = w.c.call(P[3], 'settle', [1, 0, 10]);
  t('remboursement par paquet OK', rb.success, rb.error);
  t('joueur A remboursé 4 ASE', w.chain.balanceOf(P[0]) - b0 === 4n * ASE);
  t('joueur B remboursé 2 ASE', w.chain.balanceOf(P[1]) - b1 === 2n * ASE);
  t('double remboursement refusé', !w.c.call(P[0], 'claim', [1, 0]).success);
  t('aucune commission prélevée', w.chain.balanceOf(OWNER_PAY) === 100000n * ASE);
  // Le jeu repart : la chaîne owner a avancé d'un cran, pas celle du collaborateur.
  w.buy(P[0], [[1, 2, 3, 4, 5]]);
  const d = w.draw(w.st().cur);
  t('tour suivant tiré normalement malgré le cran sauté', d.success, d.error);
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

console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
