// Tests automatisés de l'ASE Airdrop (avec le loto et la tombola) : node contrat/airdrop.test.mjs
import { readFileSync } from 'node:fs';
import { Chain } from '../sim/vm-sim.mjs';
import * as ref from './ref.mjs';
import { buildWeek, chunks } from '../airdrop/js/liste.mjs';

const rd = (f, env) => readFileSync(new URL(process.env[env] || f, import.meta.url), 'utf8');
const SRC = rd('./airdrop.js', 'AIRDROP_FILE'), LOTO = rd('./loto.js', 'LOTO_FILE'), RAFFLE = rd('./tombola.js', 'TOMBOLA_FILE');
const ASE = 10n ** 18n;
let ok = 0, ko = 0, section = '';
const t = (name, cond, extra = '') => { if (cond) ok++; else { ko++; console.log(`  ✗ [${section}] ${name}`, extra); } };
const sec = (n) => { section = n; console.log('•', n); };
const ADMIN = '0x' + 'a'.repeat(40), OWNER_PAY = '0x' + 'b'.repeat(40), COLLAB = '0x' + 'c'.repeat(40), OPER = '0x' + 'd'.repeat(40);
const P = Array.from({ length: 2000 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
const grid = (k) => [1 + (k % 16), 2 + (k % 16), 3 + (k % 16), 4 + (k % 16), 5 + (k % 16)];

// Départ : samedi 10/10/2026 12:00 UTC. Premier airdrop : dimanche 11/10 21:00 Paris.
function world({ start = Date.UTC(2026, 9, 10, 12, 0), games = true } = {}) {
  const chain = new Chain({ startTimestampMs: start, blockTimeMs: 8000 });
  for (const a of [ADMIN, OWNER_PAY, COLLAB, OPER, ...P.slice(0, 600)]) chain.fund(a, 100000n * ASE);
  const a = chain.deploy(SRC, ADMIN);
  const chO = ref.makeChain(60), chC = ref.makeChain(60);
  const r = a.call(ADMIN, 'init', [OPER, COLLAB, chO[60], chC[60]]);
  if (!r.success) throw new Error('init: ' + r.error);
  const w = { chain, a, chO, chC, st: () => a.view('getState'), round: (id) => a.view('getRound', [id]) };
  if (games) {
    w.loto = chain.deploy(LOTO, ADMIN);
    w.raffle = chain.deploy(RAFFLE, ADMIN);
    const lO = ref.makeChain(60), lC = ref.makeChain(60), rO = ref.makeChain(60), rC = ref.makeChain(60);
    if (!w.loto.call(ADMIN, 'init', [OWNER_PAY, COLLAB, COLLAB, lO[60], lC[60], a.address]).success) throw new Error('loto init');
    if (!w.raffle.call(ADMIN, 'init', [OWNER_PAY, COLLAB, COLLAB, rO[60], rC[60], a.address]).success) throw new Error('raffle init');
    const drawGame = (c, O, C, id, tally) => {
      const s = () => c.view('getState');
      c.call(P[599], 'poke');
      if (c.view('getRound', [id]).status !== 'closed') return false;
      if (!c.call(ADMIN, 'reveal', ['owner', id, ref.preimageOf(O, s().tipO)]).success) return false;
      if (!c.call(COLLAB, 'reveal', ['collab', id, ref.preimageOf(C, s().tipC)]).success) return false;
      if (tally) { let x; do { x = c.call(ADMIN, 'tally', [id, 300]); if (!x.success) return false; } while (!x.returnValue.done); }
      return true;
    };
    w.drawLoto = (id) => drawGame(w.loto, lO, lC, id, true);
    w.drawRaffle = (id) => drawGame(w.raffle, rO, rC, id, false);
    w.buyLoto = (who, n) => w.loto.call(who, 'buy', [Array.from({ length: n }, (_, k) => grid(k)), ''], 2n * ASE * BigInt(n));
    w.buyRaffle = (who, n) => w.raffle.call(who, 'buy', [n, ''], 5n * ASE * BigInt(n));
  }
  const byAddr = new Map([[a.address, a]]);
  if (games) { byAddr.set(w.loto.address, w.loto); byAddr.set(w.raffle.address, w.raffle); }
  w.view = async (addr, m, args) => byAddr.get(addr).view(m, args);
  w.week = (id) => {
    const r = w.round(id);
    return buildWeek({ view: w.view, loto: w.loto && w.loto.address, raffle: w.raffle && w.raffle.address, fromTs: w.st().lastTs, toTs: r.drawTs, now: Number(chain.timestampMs) });
  };
  w.submit = (id, entries, pot, who = OPER) => {
    const cs = chunks(entries);
    if (!cs.length) return a.call(who, 'submit', [id, 0, [], true, pot]);
    let res;
    for (let j = 0; j < cs.length; j++) { res = a.call(who, 'submit', [id, j, cs[j], j === cs.length - 1, pot]); if (!res.success) return res; }
    return res;
  };
  w.revealO = (id) => a.call(OPER, 'reveal', ['owner', id, ref.preimageOf(w.chO, w.st().tipO)]);
  w.revealC = (id) => a.call(COLLAB, 'reveal', ['collab', id, ref.preimageOf(w.chC, w.st().tipC)]);
  w.closeAirdrop = (id) => { chain.mineUntil(w.round(id).drawTs); chain.mine(1); return a.call(P[599], 'poke'); };
  w.allEntries = (id) => { const r = w.round(id), out = []; for (let j = 0; j < r.chunks; j++) out.push(...a.view('getEntries', [id, j])); return out; };
  return w;
}

sec('Initialisation');
{
  const w = world({ games: false });
  const r = w.round(1);
  t('tirage dimanche 11/10/2026 21:00 Paris', new Date(r.drawTs).toISOString() === '2026-10-11T19:00:00.000Z', new Date(r.drawTs).toISOString());
  t('opérateur et délai 6 h', w.a.view('getConfig').operator === OPER && w.a.view('getConfig').revealMin === 360);
  t('double init refusé', !w.a.call(ADMIN, 'init', [OPER, COLLAB, w.chO[60], w.chC[60]]).success);
  t('ASE refusés par poke', !w.a.call(P[0], 'poke', [], ASE).success);
}

sec('Semaine complète : loto + tombola → airdrop');
{
  const w = world();
  // Samedi : loto du samedi ; dimanche : loto + tombola du dimanche.
  t('achats loto samedi', w.buyLoto(P[0], 4).success && w.buyLoto(P[1], 1).success);
  w.chain.mineUntil(w.loto.view('getRound', [1]).closeTs); w.chain.mine(1);
  t('loto n°1 tiré', w.drawLoto(1));
  t('achats dimanche', w.buyLoto(P[0], 2).success && w.buyLoto(P[2], 3).success && w.buyRaffle(P[0], 2).success && w.buyRaffle(P[3], 5).success && w.buyRaffle(P[4], 1).success);
  const bal0 = w.chain.balanceOf(w.a.address);
  w.closeAirdrop(1);
  t('airdrop fermé à 21h00', w.round(1).status === 'closed' && w.st().cur === 2);
  let wk = await w.week(1);
  t('liste pas prête tant que les jeux du dimanche ne sont pas tirés', !wk.ready && wk.waiting.length === 2, JSON.stringify(wk.waiting));
  t('loto n°2 et tombola n°1 tirés', w.drawLoto(2) && w.drawRaffle(1));
  wk = await w.week(1);
  const received = w.chain.balanceOf(w.a.address) - bal0 + bal0;
  t('liste prête', wk.ready, JSON.stringify(wk.waiting));
  t('1 grille / 1 ticket = 1 chance', JSON.stringify(wk.entries) === JSON.stringify([[P[0], 8], [P[1], 1], [P[2], 3], [P[3], 5], [P[4], 1]]), JSON.stringify(wk.entries));
  t('cagnotte = frais reçus par le contrat Airdrop (7,5 %)', BigInt(wk.pot) === received && received === (10n * 2n * ASE + 8n * 5n * ASE) * 75n / 1000n, wk.pot + ' / ' + received);
  t('3 tirages comptés', wk.games.length === 3);
  t('révélation avant la liste refusée', !w.revealO(1).success);
  t('un joueur ne peut pas envoyer la liste', !w.submit(1, wk.entries, wk.pot, P[0]).success);
  const unsorted = [wk.entries[1], wk.entries[0]];
  t('liste non triée refusée', !w.a.call(OPER, 'submit', [1, 0, unsorted, false, '0']).success);
  t('doublon refusé', !w.a.call(OPER, 'submit', [1, 0, [wk.entries[0], wk.entries[0]], false, '0']).success);
  t('0 ticket refusé', !w.a.call(OPER, 'submit', [1, 0, [[P[0], 0]], false, '0']).success);
  t('morceau partiel puis recommencer (idx 0)', w.a.call(OPER, 'submit', [1, 0, [[P[9], 50]], false, '0']).success && w.a.call(OPER, 'submit', [1, 0, [[P[8], 50]], false, '0']).success && w.round(1).tickets === 50);
  t('mauvais n° de morceau refusé', !w.a.call(OPER, 'submit', [1, 3, [[P[9], 1]], false, '0']).success);
  const sb = w.submit(1, wk.entries, wk.pot);
  t('liste envoyée', sb.success && w.round(1).status === 'listed', sb.error);
  t('liste lisible = liste recalculée', JSON.stringify(w.allEntries(1)) === JSON.stringify(wk.entries));
  t('liste figée après envoi', !w.a.call(OPER, 'submit', [1, 0, [], true, '0']).success);
  t('collab avant owner refusé', !w.revealC(1).success);
  t('owner : secret 2 maillons plus loin refusé', !w.a.call(OPER, 'reveal', ['owner', 1, w.chO[58]]).success);
  t('owner révèle', w.revealO(1).success);
  const before = [P[0], P[1], P[2], P[3], P[4]].map((x) => w.chain.balanceOf(x));
  const rc = w.revealC(1);
  t('collab révèle → gagnants payés (gas ' + rc.gas + ')', rc.success, rc.error);
  const r = w.round(1);
  let d = ref.airdropInitialDigest(1);
  for (const c of chunks(wk.entries)) d = ref.airdropNextDigest(d, c);
  t('empreinte recalculable', r.digest === d);
  const exp = ref.airdropWinners(1, r.sO, r.sC, r.digest, wk.entries);
  t('gagnants = référence indépendante', JSON.stringify(r.win) === JSON.stringify(exp), JSON.stringify([r.win, exp]));
  t('3 wallets différents', new Set(r.win.map((x) => x.b)).size === 3);
  const pz = ref.airdropPrizes(wk.pot);
  t('prix 50 / 30 / 20 %', JSON.stringify(r.prizes) === JSON.stringify(pz.map(String)));
  const gained = [P[0], P[1], P[2], P[3], P[4]].map((x, i) => w.chain.balanceOf(x) - before[i]);
  t('prix envoyés directement aux gagnants', r.win.every((x, k) => gained[P.indexOf(x.b)] === pz[k]));
  t('cagnotte vidée (rien de reporté)', w.st().carry === '0' && w.chain.balanceOf(w.a.address) === 0n);
  t('semaine suivante : départ = ce tirage', w.st().lastTs === r.drawTs && w.st().next === 2);

  sec('Semaine 2 : 2 wallets seulement → 20 % reportés');
  w.buyLoto(P[5], 2); w.buyRaffle(P[5], 1); w.buyRaffle(P[6], 1); w.buyRaffle(P[7], 1);
  for (let id = 3; id <= 9; id++) { const lr = w.loto.view('getRound', [id]); if (!lr) break; w.chain.mineUntil(lr.closeTs); w.chain.mine(1); w.drawLoto(id); }
  w.closeAirdrop(2);
  const rr = w.raffle.view('getRound', [2]);
  w.chain.mineUntil(rr.closeTs); w.chain.mine(1); w.drawRaffle(2);
  const wk2 = await w.week(2);
  t('semaine 2 prête : 3 wallets (loto + tombola cumulés)', wk2.ready && JSON.stringify(wk2.entries) === JSON.stringify([[P[5], 3], [P[6], 1], [P[7], 1]]), JSON.stringify(wk2));
  const two = wk2.entries.slice(0, 2);
  t('liste de 2 wallets (cas d\'école)', w.submit(2, two, wk2.pot).success && w.revealO(2).success && w.revealC(2).success);
  const r2 = w.round(2);
  t('2 gagnants', r2.win.length === 2);
  t('le 3e prix (20 %) est reporté', w.st().carry === r2.prizes[2] && w.chain.balanceOf(w.a.address) === BigInt(r2.prizes[2]));
}

sec('Semaine sans participant : rien à tirer, cagnotte reportée');
{
  const w = world({ games: false });
  w.closeAirdrop(1);
  const r = w.submit(1, [], '0');
  t('liste vide → tirage clos sans secret', r.success && w.round(1).status === 'done' && w.st().next === 2, r.error);
  t('ajout volontaire (fund)', w.a.call(ADMIN, 'fund', [], 10n * ASE).success && w.st().carry === (10n * ASE).toString());
  t('fund sans ASE refusé', !w.a.call(ADMIN, 'fund', [], 0n).success);
  w.closeAirdrop(2);
  w.submit(2, [[P[0], 3]], '0'); w.revealO(2);
  const b = w.chain.balanceOf(P[0]);
  t('1 seul wallet : il gagne 50 % de la cagnotte reportée', w.revealC(2).success && w.chain.balanceOf(P[0]) - b === 5n * ASE);
  t('le reste est reporté', w.st().carry === (5n * ASE).toString() && w.chain.balanceOf(w.a.address) === 5n * ASE);
  t('lowerCarry refusé à un joueur', !w.a.call(P[0], 'lowerCarry', ['0']).success);
  t('lowerCarry ne peut que baisser', !w.a.call(ADMIN, 'lowerCarry', [(6n * ASE).toString()]).success && w.a.call(ADMIN, 'lowerCarry', [(4n * ASE).toString()]).success);
}

sec('Tirage non fait en 6 h → annulé, la semaine est reprise au tirage suivant');
{
  const w = world();
  w.buyLoto(P[0], 1);
  w.chain.mineUntil(w.loto.view('getRound', [1]).closeTs); w.chain.mine(1); w.drawLoto(1);
  w.closeAirdrop(1);
  t('annulation refusée avant 6 h', !w.a.call(P[3], 'cancelExpired', [1]).success);
  w.chain.mineUntil(w.round(1).drawTs + 360 * 60000);
  t('liste trop tard refusée', !w.submit(1, [[P[0], 1]], '0').success);
  t('n\'importe qui annule après 6 h', w.a.call(P[3], 'cancelExpired', [1]).success && w.round(1).status === 'cancelled' && w.st().next === 2);
  w.buyLoto(P[1], 2);
  for (let id = 2; id <= 9; id++) { const lr = w.loto.view('getRound', [id]); if (!lr || lr.drawTs > w.round(2).drawTs) break; w.chain.mineUntil(lr.closeTs); w.chain.mine(1); w.drawLoto(id); }
  w.closeAirdrop(2);
  const wk = await w.week(2);
  t('semaine 2 = semaines 1 + 2 (participants et frais)', wk.ready && JSON.stringify(wk.entries) === JSON.stringify([[P[0], 1], [P[1], 2]]) && BigInt(wk.pot) === w.chain.balanceOf(w.a.address), JSON.stringify(wk));
  t('tirage normal', w.submit(2, wk.entries, wk.pot).success && w.revealO(2).success && w.revealC(2).success);
}

sec('Cagnotte surévaluée → refus (le contrat ne peut pas payer plus qu\'il n\'a)');
{
  const w = world({ games: false });
  w.a.call(ADMIN, 'fund', [], ASE);
  w.closeAirdrop(1);
  w.submit(1, [[P[0], 1], [P[1], 1], [P[2], 1]], (100n * ASE).toString());
  w.revealO(1);
  t('collab : refus (solde insuffisant)', !w.revealC(1).success && w.round(1).status === 'listed');
}

sec('Plusieurs semaines sans croupier : rattrapage');
{
  const w = world({ games: false });
  w.chain.mineUntil(w.round(1).drawTs + 22 * 86400000);
  w.a.call(P[0], 'poke');
  t('les semaines manquées sont regroupées : tirage 2 au prochain dimanche', w.st().cur === 2 && w.round(2).drawTs > Number(w.chain.timestampMs) && w.round(2).drawTs - Number(w.chain.timestampMs) <= 7 * 86400000, JSON.stringify(w.st()));
  t('le tirage 1 expiré s\'annule', w.a.call(P[0], 'cancelExpired', [1]).success && w.st().next === 2 && w.st().lastTs === 0);
}

sec('Grosse liste : 1500 wallets');
{
  const w = world({ games: false });
  w.a.call(ADMIN, 'fund', [], 100n * ASE);
  w.closeAirdrop(1);
  const entries = P.slice(0, 1500).map((b, i) => [b, 1 + (i % 140)]);
  let maxGas = 0;
  for (const [j, c] of chunks(entries).entries()) {
    const r = w.a.call(OPER, 'submit', [1, j, c, j === 14, '0']);
    if (!r.success) { t('morceau ' + j, false, r.error); break; }
    maxGas = Math.max(maxGas, r.gas);
  }
  t('15 morceaux envoyés (gas max ' + maxGas + ')', w.round(1).status === 'listed' && maxGas < 1_000_000);
  w.revealO(1);
  const rc = w.revealC(1);
  t('tirage : gas ' + rc.gas + ' < 1 000 000', rc.success && rc.gas < 1_000_000, rc.error);
  const r = w.round(1);
  t('= référence', JSON.stringify(r.win) === JSON.stringify(ref.airdropWinners(1, r.sO, r.sC, r.digest, entries)));
  t('plus de 100 par morceau refusé', !world({ games: false }).a.call(OPER, 'submit', [1, 0, entries.slice(0, 101), false, '0']).success);
}

sec('Équité : chances proportionnelles aux tickets (1er gagnant)');
{
  const entries = [[P[0], 1], [P[1], 3], [P[2], 6]];
  const hits = [0, 0, 0];
  for (let k = 0; k < 6000; k++) {
    const sO = ref.sha('o' + k), sC = ref.sha('c' + k);
    const w0 = ref.airdropWinners(1, sO, sC, 'x', entries)[0];
    hits[entries.findIndex((e) => e[0] === w0.b)]++;
  }
  t('≈ 10 % / 30 % / 60 %', Math.abs(hits[0] / 6000 - 0.1) < 0.02 && Math.abs(hits[1] / 6000 - 0.3) < 0.025 && Math.abs(hits[2] / 6000 - 0.6) < 0.025, hits.join('/'));
}

sec('Admin');
{
  const w = world({ games: false });
  for (const [m, a] of [['setConfig', [0, 21, 0, 360]], ['setOperator', [P[0]]], ['setAdmin', [P[0]]], ['setTipOwner', ['a'.repeat(64)]], ['lowerCarry', ['0']]])
    t(`${m} refusé à un joueur`, !w.a.call(P[0], m, a).success);
  t('changer l\'heure : samedi 20h30', w.a.call(ADMIN, 'setConfig', [6, 20, 30, 240]).success && ref.parisHM(w.round(1).drawTs) === '20:30');
  t('délai < 60 min refusé', !w.a.call(ADMIN, 'setConfig', [0, 21, 0, 30]).success);
  t('changer l\'opérateur', w.a.call(ADMIN, 'setOperator', [P[1]]).success && w.a.view('getConfig').operator === P[1]);
  t('setTipCollab réservé au collaborateur', !w.a.call(ADMIN, 'setTipCollab', ['b'.repeat(64)]).success && w.a.call(COLLAB, 'setTipCollab', ['b'.repeat(64)]).success);
  const i = w.a.view('info');
  t('info lisible', i.round === 1 && i.carry === '0' && i.fromTs === '0');
}

console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
