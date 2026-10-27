// Tests automatisés d'ASE Treasure : node contrat/tresor.test.mjs
import { readFileSync } from 'node:fs';
import { Chain } from '../sim/vm-sim.mjs';
import { board, verify, CELLS } from '../functions/_lib/board.mjs';

const SRC = readFileSync(new URL(process.env.TRESOR_FILE || './tresor.js', import.meta.url), 'utf8');
const ASE = 10n ** 18n, PRICE = 5n * 10n ** 17n;
let ok = 0, ko = 0, section = '';
const t = (name, cond, extra = '') => { if (cond) ok++; else { ko++; console.log(`  ✗ [${section}] ${name}`, extra); } };
const sec = (n) => { section = n; console.log('•', n); };
const ADMIN = '0x' + 'a'.repeat(40), OWN = '0x' + 'b'.repeat(40), COL = '0x' + 'c'.repeat(40), OPER = '0x' + 'd'.repeat(40), DROP = '0x' + 'f'.repeat(40);
const P = Array.from({ length: 120 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
const SEED = 'ab'.repeat(32);

function world() {
  const chain = new Chain({ startTimestampMs: Date.UTC(2026, 9, 11, 15), blockTimeMs: 8000 });
  for (const a of [ADMIN, OWN, COL, OPER, DROP, ...P]) chain.fund(a, 1000n * ASE);
  const c = chain.deploy(SRC, ADMIN);
  const r = c.call(ADMIN, 'init', [OPER, OWN, COL, DROP]);
  if (!r.success) throw new Error(r.error);
  const w = {
    chain, c, st: () => c.view('getState'), g: (id) => c.view('getGrid', [id]),
    open: (id) => { const b = board(SEED, id); return [c.call(OPER, 'openGrid', [id, b.root]), b]; },
    dig: (who, id, cell, v = PRICE) => c.call(who, 'dig', [id, cell], v),
    claim: (id, b, who = P[119]) => { const a = b.answer(b.treasure); return c.call(who, 'claim', [id, a.cell, a.salt, a.proof]); },
    bal: () => chain.balanceOf(c.address),
  };
  return w;
}
// cases froides (pas le trésor, pas chaudes)
const colds = (b) => b.cells.map((x, i) => [x.ans, i]).filter(([a]) => a === 'C').map(([, i]) => i);

sec('Grille secrète (board.mjs)');
{
  const b = board(SEED, 1);
  t('1 trésor, réponses cohérentes', b.cells.filter((x) => x.ans === 'T').length === 1 && b.cells[b.treasure].ans === 'T');
  t('chaque réponse a une preuve valide', [0, 17, 199, b.treasure, 399].every((i) => { const a = b.answer(i); return verify(b.root, 1, i, a.ans, a.salt, a.proof); }));
  t('preuve refusée si on change la réponse', !verify(b.root, 1, 5, b.cells[5].ans === 'C' ? 'H' : 'C', b.cells[5].salt, b.answer(5).proof));
  t('une autre grille = autre trésor / racine', board(SEED, 2).root !== b.root);
  // répartition du trésor sur 2000 grilles
  const seen = new Set(); for (let g = 1; g <= 2000; g++) seen.add(board(SEED, g).treasure);
  t('le trésor peut être partout (' + seen.size + ' cases sur 400)', seen.size > 390);
}

sec('Ouverture d\'une grille');
{
  const w = world();
  t('prix 0,5 ASE, 5 fouilles par wallet', w.c.view('getConfig').price === PRICE.toString() && w.c.view('getConfig').maxPerWallet === 5);
  t('pas de fouille avant la 1re grille', !w.dig(P[0], 1, 0).success);
  t('un joueur ne peut pas ouvrir', !w.c.call(P[0], 'openGrid', [1, board(SEED, 1).root]).success);
  t('mauvais n° refusé', !w.c.call(OPER, 'openGrid', [2, board(SEED, 2).root]).success);
  const [r] = w.open(1);
  t('opérateur ouvre la grille 1', r.success, r.error);
  t('pas de 2e grille tant que la 1re est ouverte', !w.open(2)[0].success);
}

sec('Fouilles');
{
  const w = world(); const [, b] = w.open(1); const cs = colds(b);
  const bo = w.chain.balanceOf(OWN), bc = w.chain.balanceOf(COL), bd = w.chain.balanceOf(DROP);
  const r = w.dig(P[0], 1, cs[0]);
  t('fouille OK (gas ' + r.gas + ')', r.success && r.returnValue.idx === 0, r.error);
  const com = PRICE * 15n / 100n, drop = com * 6n / 15n, own = (com - drop) * 3n / 4n;
  t('commission versée dès la fouille (Airdrop 6 %, équipe 75/25)', w.chain.balanceOf(DROP) - bd === drop && w.chain.balanceOf(OWN) - bo === own && w.chain.balanceOf(COL) - bc === com - drop - own);
  t('85 % restent pour le trésor', w.bal() === PRICE - com);
  t('fouille horodatée', w.c.view('getDigs', [1, 0, 1])[0].t > 0);
  t('événement Dig', r.events.some((e) => e.name === 'Dig' && e.data.cell === String(cs[0])));
  t('case déjà fouillée refusée', !w.dig(P[1], 1, cs[0]).success);
  t('mauvais montant refusé', !w.dig(P[1], 1, cs[1], ASE).success);
  t('case hors grille refusée', !w.dig(P[1], 1, 400).success && !w.dig(P[1], 1, -1).success && !w.dig(P[1], 1, 1.5).success);
  for (let k = 1; k < 5; k++) w.dig(P[0], 1, cs[k]);
  t('6e fouille du même wallet refusée', !w.dig(P[0], 1, cs[5]).success);
  t('cellOf', w.c.view('cellOf', [1, cs[0]]) === 0 && w.c.view('cellOf', [1, cs[9]]) === -1);
  const i = w.c.view('info');
  t('info : 5 fouilles, trésor = 85 %', i.digs === 5 && i.pot === (5n * PRICE * 85n / 100n).toString());
  t('pause bloque les fouilles', w.c.call(ADMIN, 'setPaused', [true]).success && !w.dig(P[1], 1, cs[6]).success);
}

sec('Trésor trouvé');
{
  const w = world(); const [, b] = w.open(1); const cs = colds(b);
  for (let k = 0; k < 12; k++) w.dig(P[k], 1, cs[k]);
  const fake = b.answer(cs[0]);
  t('claim avec une case froide refusé', !w.c.call(P[0], 'claim', [1, fake.cell, fake.salt, fake.proof]).success);
  t('claim du trésor pas encore fouillé refusé', !w.claim(1, b).success);
  w.dig(P[50], 1, b.treasure);                 // 13e fouille : le trésor
  w.dig(P[51], 1, cs[20]); w.dig(P[52], 1, cs[21]);  // 2 fouilles juste après → grille suivante
  const bw = w.chain.balanceOf(P[50]), bd = w.chain.balanceOf(DROP);
  const r = w.claim(1, b);
  t('claim par un tiers (gas ' + r.gas + ')', r.success, r.error);
  const S = 13n * PRICE, com = S * 15n / 100n, net = PRICE * 85n / 100n;
  t('le gagnant reçoit 85 % des 13 fouilles (5,525 ASE)', w.chain.balanceOf(P[50]) - bw === S - com && S - com === 5525n * 10n ** 15n);
  t('rien de plus pour l\'Airdrop au claim (déjà versé)', w.chain.balanceOf(DROP) === bd);
  const g = w.g(1);
  t('grille terminée', g.status === 'found' && g.winner === P[50] && g.t === 12 && g.cell === b.treasure);
  t('double claim refusé', !w.claim(1, b).success);
  t('plus de fouille sur la grille terminée', !w.dig(P[60], 1, cs[30]).success);
  t('2 fouilles après le trésor → reportées (pas de remboursement)', w.st().carry === (2n * net).toString() && g.carryOut === (2n * net).toString() && w.bal() === 2n * net && !w.c.api.settle);
  t('info : trésor de départ de la prochaine grille', w.c.view('info').pot === (2n * net).toString());
  const [r2, b2] = w.open(2);
  t('grille suivante ouverte avec le report', r2.success && w.c.view('info').grid === 2 && w.g(2).carryIn === (2n * net).toString() && w.st().carry === '0');
  t('le compteur par wallet repart à 0', w.dig(P[0], 2, colds(b2)[0]).success);
  t('trésor affiché = report + 85 %', w.c.view('info').pot === (3n * net).toString());
  const bt = w.chain.balanceOf(P[1]);
  w.dig(P[1], 2, b2.treasure);
  t('le gagnant de la grille 2 touche aussi le report', w.claim(2, b2).success && w.chain.balanceOf(P[1]) - bt === 4n * net - PRICE && w.bal() === 0n);
}

sec('Le trésor au 1er coup');
{
  const w = world(); const [, b] = w.open(1);
  w.dig(P[0], 1, b.treasure);
  t('claim OK', w.claim(1, b, P[0]).success && w.g(1).prize === (PRICE * 85n / 100n).toString());
}

sec('Grille complète : 400 fouilles');
{
  const w = world(); const [, b] = w.open(1);
  w.c.call(ADMIN, 'setConfig', [PRICE.toString(), 400]);
  const [, b2] = [0, board(SEED, 1)];
  let maxGas = 0;
  for (let i = 0; i < CELLS; i++) { if (i === b.treasure) continue; const r = w.dig(P[i % 100], 1, i); if (!r.success) { t('fouille ' + i, false, r.error); break; } maxGas = Math.max(maxGas, r.gas); }
  w.dig(P[0], 1, b.treasure);
  const r = w.claim(1, b2);
  t('399 fouilles puis trésor (gas max fouille ' + maxGas + ', claim ' + r.gas + ')', r.success && maxGas < 200000 && r.gas < 1_000_000);
  t('contrat vide après le claim', w.st().carry === '0' && w.bal() === 0n);
}

sec('Aucune annulation');
{
  const w = world(); w.open(1);
  t('ni cancelExpired, ni emergencyCancel, ni settle', !w.c.api.cancelExpired && !w.c.api.emergencyCancel && !w.c.api.settle);
  w.chain.mineUntil(w.g(1).openTs + 60 * 86400000);
  t('grille toujours ouverte après 60 jours', w.g(1).status === 'open' && w.dig(P[0], 1, colds(board(SEED, 1))[0]).success);
}

sec('Admin');
{
  const w = world();
  for (const [m, a] of [['setConfig', [PRICE.toString(), 5]], ['setPayouts', [P[0], P[0], P[0]]], ['setOperator', [P[0]]], ['setAdmin', [P[0]]], ['setPaused', [true]]])
    t(`${m} refusé à un joueur`, !w.c.call(P[0], m, a).success);
  t('nouveau prix pour la grille suivante', w.c.call(ADMIN, 'setConfig', [ASE.toString(), 3]).success && w.open(1)[0].success && w.g(1).price === ASE.toString());
  t('init une seule fois', !w.c.call(ADMIN, 'init', [OPER, OWN, COL, DROP]).success);
}

console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
