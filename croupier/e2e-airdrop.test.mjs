// Test de bout en bout du croupier avec l'ASE AIRDROP (+ loto et tombola sur le même nœud) :
//   node croupier/e2e-airdrop.test.mjs
import { readFileSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startMockNode } from '../sim/mock-node.mjs';
import * as ref from '../contrat/ref.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(HERE, '..', 'contrat', f), 'utf8');
const ASE = 10n ** 18n;
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log('  ✓', name); } else { ko++; console.log('  ✗', name, extra); } };

const mock = await startMockNode({ source: src('airdrop.js'), extra: [src('loto.js'), src('tombola.js')], blockMs: 100 });
const A = mock.contract, [L, R] = mock.others;
const ADMIN = '0x' + 'a'.repeat(40), OWN_PAY = '0x' + 'd'.repeat(40), COL_PAY = '0x' + 'e'.repeat(40);
const players = Array.from({ length: 8 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
players.forEach((p) => mock.chain.fund(p, 1000n * ASE)); mock.chain.fund(ADMIN, ASE);
const cry = await import(pathToFileURL(join(HERE, 'node_modules/@asentum/crypto/dist/index.js')).href);
const addrOf = (seed) => cry.addressFromPublicKey(cry.generateKeypair(Uint8Array.from(Buffer.from(seed, 'hex'))).publicKey).toLowerCase();
const seedO = randomBytes(32).toString('hex'), seedC = randomBytes(32).toString('hex');
mock.chain.fund(addrOf(seedO), 10n * ASE); mock.chain.fund(addrOf(seedC), 10n * ASE);
const chO = ref.makeChain(40), chC = ref.makeChain(40);
const g = [ref.makeChain(20), ref.makeChain(20), ref.makeChain(20), ref.makeChain(20)];
t('airdrop initialisé (opérateur = signataire owner)', A.call(ADMIN, 'init', [addrOf(seedO), ADMIN, chO[40], chC[40]]).success);
t('loto et tombola initialisés vers l\'airdrop', L.call(ADMIN, 'init', [OWN_PAY, COL_PAY, ADMIN, g[0][20], g[1][20], A.address]).success && R.call(ADMIN, 'init', [OWN_PAY, COL_PAY, ADMIN, g[2][20], g[3][20], A.address]).success);
const drawGame = (c, O, C, id, tally) => {
  c.call(ADMIN, 'poke');
  const s = () => c.view('getState');
  c.call(ADMIN, 'reveal', ['owner', id, ref.preimageOf(O, s().tipO)]);
  c.call(ADMIN, 'reveal', ['collab', id, ref.preimageOf(C, s().tipC)]);
  if (tally) for (let k = 0; k < 5 && c.view('getRound', [id]).status === 'tally'; k++) c.call(ADMIN, 'tally', [id, 300]);
  return c.view('getRound', [id]).status === 'done';
};

const base = { ...process.env, CONTRACT: A.address, LOTO_CONTRACT: L.address, RAFFLE_CONTRACT: R.address, GAME: 'airdrop', RPC_URL: mock.url, ACCOUNT: '', ASENTUM_BIN: '/nonexistent', CHAIN_LENGTH: '40', POLL_MS: '150',
  RECEIPT_TIMEOUT_MS: '15000', MAX_RUN_MS: '20000', TELEGRAM_TOKEN: 'x', TELEGRAM_CHAT_ID: '1', TELEGRAM_API: mock.url + '/__alert', ENV_FILE: '/nonexistent' };
const envO = { ...base, ROLE: 'owner', SIGNER_SEED: seedO, CHAIN_SEED: chO[0], DATA_DIR: mkdtempSync(join(tmpdir(), 'ao-')) };
const envC = { ...base, ROLE: 'collab', SIGNER_SEED: seedC, CHAIN_SEED: chC[0], DATA_DIR: mkdtempSync(join(tmpdir(), 'ac-')) };
const once = (env, cmd = 'once') => new Promise((res) => {
  const p = spawn('node', [join(HERE, 'croupier.mjs'), cmd], { env });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('exit', (code) => { if (process.env.VERBOSE) console.log(out); res({ code, out }); });
});
const warp = (to) => fetch(mock.url + '/__warp', { method: 'POST', body: JSON.stringify({ to }) });

// Samedi : loto (3 joueurs) + tombola (4 joueurs)
const grid = [1, 2, 3, 4, 5];
L.call(players[0], 'buy', [[grid, grid, grid], ''], 6n * ASE);
L.call(players[1], 'buy', [[grid], ''], 2n * ASE);
L.call(players[5], 'buy', [[grid, grid], ''], 4n * ASE);
for (let i = 0; i < 4; i++) R.call(players[i + 2], 'buy', [i + 1, ''], BigInt(i + 1) * 5n * ASE);
await warp(L.view('getRound', [1]).closeTs + 1000);
t('loto du samedi tiré', drawGame(L, g[0], g[1], 1, true));
const st0 = await once(envO, 'status');
t('status airdrop lisible', st0.code === 0 && /OK, 40 secrets/.test(st0.out), st0.out.slice(-300));
await warp(R.view('getRound', [1]).closeTs + 1000);
t('grosse tombola du dimanche tirée', drawGame(R, g[2], g[3], 1, false));
await warp(A.view('getRound', [1]).drawTs - 3 * 3600000);
t('achat loto lundi', L.call(players[6], 'buy', [[grid], ''], 2n * ASE).success);
await warp(A.view('getRound', [1]).drawTs + 60000);
const a = await once(envO);
t('lundi 21h01 : airdrop fermé, en attente du loto du lundi', a.code === 0 && A.view('getRound', [1]).status === 'closed' && /en attente des jeux \(loto #3/.test(a.out), a.out.slice(-400));
t('loto du lundi tiré', drawGame(L, g[0], g[1], 3, true));
const q1 = await once(envO);
const r1 = A.view('getRound', [1]);
t('passage owner : liste envoyée + secret owner', q1.code === 0 && r1.status === 'listed' && !!r1.sO, q1.out.slice(-400));
t('liste : 1 grille / 1 ticket = 1 chance', JSON.stringify(A.view('getEntries', [1, 0])) === JSON.stringify([[players[0], 3], [players[1], 1], [players[2], 1], [players[3], 2], [players[4], 3], [players[5], 6], [players[6], 1]]), JSON.stringify(A.view('getEntries', [1, 0])));
t('cagnotte = frais reçus', BigInt(r1.pot) === mock.chain.balanceOf(A.address) && BigInt(r1.pot) === (14n + 50n) * ASE * 75n / 1000n);
const bal = players.map((p) => mock.chain.balanceOf(p));
const q2 = await once(envC);
const r = A.view('getRound', [1]);
t('passage collab : 3 gagnants, prix envoyés', q2.code === 0 && r.status === 'done' && r.win.length === 3, q2.out.slice(-300));
t('gagnants = référence indépendante', JSON.stringify(r.win) === JSON.stringify(ref.airdropWinners(1, r.sO, r.sC, r.digest, A.view('getEntries', [1, 0]))));
t('chaque gagnant a reçu son prix', r.win.every((w, k) => mock.chain.balanceOf(w.b) - bal[players.indexOf(w.b)] === BigInt(r.prizes[k])));
t('annonce Telegram', mock.alerts.some((x) => x.includes('ASE Airdrop n°1')), mock.alerts.join(' | ').slice(0, 300));
const q3 = await once(envO);
t('passage suivant : rien à faire', q3.code === 0 && /0 transaction/.test(q3.out), q3.out.slice(-200));

mock.stop();
console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
