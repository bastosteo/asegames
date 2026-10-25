// Tests de la sentinelle : node croupier/sentinelle.test.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fundLinks, coordination, answerAt, toHex, toAse1, main } from './sentinelle.mjs';

let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) ok++; else { ko++; console.log('  ✗', name, extra); } };
const A = (n) => '0x' + n.toString(16).padStart(40, '0');
const BAN = A(1), BOT1 = A(2), BOT2 = A(3), HONEST = A(4), DEX = A(5);

// --- adresses
t('ase1 ↔ 0x', toHex('ase1qp9cmkk06mtjjezqsrhrqqslz3evea5hahmlgv') === '0x004b8ddacfd6d729644080ee30021f1472ccf697' && toAse1('0x004b8ddacfd6d729644080ee30021f1472ccf697') === 'ase1qp9cmkk06mtjjezqsrhrqqslz3evea5hahmlgv');

// --- liens de fonds
const tx = (from, to, ase, extra = {}) => ({ hash: '0x' + Math.random().toString(16).slice(2).padEnd(64, '0'), timestamp: 1000, from_addr: from, to_addr: to, value: (BigInt(ase * 1000) * 10n ** 15n).toString(), status: 1, method: 'transfer', ...extra });
const rows = [
  tx(BAN, BOT1, 10), tx(BOT2, BAN, 200),
  tx(toAse1(BAN), DEX, 5, { method: 'swapExactIn' }),           // appel de contrat : ignoré
  tx(BAN, HONEST, 1, { status: 0 }),                            // échouée : ignorée
  tx(toAse1(BAN), BOT1, 1),                                     // l'indexeur rend parfois l'adresse en ase1…
];
const L = fundLinks(new Set([BAN]), new Map([[BAN, rows]]));
t('financé par le banni → lien', L.has(BOT1) && L.get(BOT1).proofs[0].dir === 'reçu de');
t('gains reversés au banni → lien', L.has(BOT2) && L.get(BOT2).proofs[0].dir === 'envoyé à');
t('appels de contrat et transactions échouées ignorés', !L.has(DEX) && !L.has(HONEST));
t('adresse ase1… du banni reconnue comme lui-même', !L.has(BAN) && L.size === 2 && L.get(BOT1).proofs.length === 2);

// --- coordination : deux wallets dans le même bloc sur les dernières cases
function grid(id, T, digs) { return { g: { id, status: 'found', cell: T }, digs }; }
function botGrid(id, T, ts) {
  // éclaireurs honnêtes : les cases chaudes autour du trésor, sauf 2 ; puis les 2 bots raflent ces 2 cases dans le même bloc
  const hot = [...Array(400).keys()].filter((c) => answerAt(c, T) === 'H');
  const X = hot.pop();
  const digs = hot.map((c, n) => ({ idx: n, b: A(100 + n), c, t: ts + n * 60000 }));
  digs.push({ idx: digs.length, b: BOT1, c: T, t: ts + 999e5 }, { idx: digs.length + 1, b: BOT2, c: X, t: ts + 999e5 });
  return grid(id, T, digs);
}
const P = coordination([botGrid(1, 210, 0), botGrid(2, 45, 10e6), botGrid(3, 333, 20e6)]);
const pair = P.find((p) => [p.a, p.b].sort().join() === [BOT1, BOT2].sort().join());
t('bots repérés sur 3 grilles', pair && pair.grids.length === 3, JSON.stringify(P.slice(0, 3)));
t('pas de faux couple chez les éclaireurs', P.filter((p) => p.grids.length >= 3).length === 1);
const early = coordination([grid(9, 210, [{ idx: 0, b: HONEST, c: 0, t: 5 }, { idx: 1, b: DEX, c: 399, t: 5 }, { idx: 2, b: BOT1, c: 210, t: 9 }])]);
t('même bloc en début de grille (beaucoup de cases possibles) : ignoré', !early.some((p) => p.a === HONEST || p.b === HONEST));

// --- passage complet (réseau simulé) : un message, puis rien au passage suivant
const msgs = [];
const now = Date.now();
const grids = [1, 2, 3].map((i) => botGrid(i, [210, 45, 333][i - 1], now - 3600000 * (4 - i)));
for (const x of grids) { x.g.endTs = x.digs.at(-1).t; x.g.digs = x.digs.length; }
globalThis.fetch = async (url, o = {}) => {
  const res = (v) => ({ ok: true, text: async () => JSON.stringify(v), json: async () => v });
  if (url.endsWith('/view')) {
    const { method, args } = JSON.parse(o.body);
    if (method === 'getBans') return res({ ok: true, returnValue: [{ a: BAN, ts: 1 }] });
    if (method === 'getState') return res({ ok: true, returnValue: { cur: 3 } });
    if (method === 'getGrid') return res({ ok: true, returnValue: grids[args[0] - 1].g });
    if (method === 'getDigs') return res({ ok: true, returnValue: grids[args[0] - 1].digs });
  }
  if (url.includes('/api/indexer/address/')) return res(url.includes(BAN) && url.includes('page=1') ? { rows, total: rows.length } : { rows: [], total: 0 });
  if (url.includes('api.telegram.org')) { msgs.push(JSON.parse(o.body).text); return res({ ok: true }); }
  throw new Error('url inattendue ' + url);
};
Object.assign(process.env, { CONTRACT: 'ase1test', DATA_DIR: mkdtempSync(join(tmpdir(), 'sent-')), TELEGRAM_TOKEN: 'x', TELEGRAM_CHAT_ID: '1' });
const quiet = console.log; console.log = () => {};
await main();
const first = [...msgs];
await main();
console.log = quiet;
t('1er passage : une alerte de fonds groupée (2 wallets) + une alerte de bot', first.length === 2 && /2 wallets/.test(first[0]) && first[0].includes(toAse1(BOT1)) && first[0].includes(toAse1(BOT2)) && /Bot multi-wallets/.test(first[1]), JSON.stringify(first));
t('l\'alerte contient la preuve (lien de transaction)', /\/tx\/0x[0-9a-f]+/.test(first[0]));
t('jamais de bannissement automatique (aucune écriture sur la chaîne)', true);
t('2e passage : pas de doublon', msgs.length === 2, JSON.stringify(msgs.slice(2)));

console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
