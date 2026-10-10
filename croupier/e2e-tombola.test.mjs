// Test de bout en bout du croupier avec la TOMBOLA, en mode GitHub Actions :
//   node croupier/e2e-tombola.test.mjs
import { readFileSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startMockNode } from '../sim/mock-node.mjs';
import * as ref from '../contrat/ref.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'contrat', 'tombola.js'), 'utf8');
const ASE = 10n ** 18n;
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log('  ✓', name); } else { ko++; console.log('  ✗', name, extra); } };

const mock = await startMockNode({ source: SRC, blockMs: 100 });
const C = mock.contract;
const ADMIN = '0x' + 'a'.repeat(40), OWN_PAY = '0x' + 'd'.repeat(40), COL_PAY = '0x' + 'e'.repeat(40);
const players = Array.from({ length: 8 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
players.forEach((p) => mock.chain.fund(p, 1000n * ASE)); mock.chain.fund(ADMIN, ASE);
const cry = await import(pathToFileURL(join(HERE, 'node_modules/@asentum/crypto/dist/index.js')).href);
const addrOf = (seed) => cry.addressFromPublicKey(cry.generateKeypair(Uint8Array.from(Buffer.from(seed, 'hex'))).publicKey).toLowerCase();
const seedO = randomBytes(32).toString('hex'), seedC = randomBytes(32).toString('hex');
mock.chain.fund(addrOf(seedO), 10n * ASE); mock.chain.fund(addrOf(seedC), 10n * ASE);
const chO = ref.makeChain(40), chC = ref.makeChain(40);
t('tombola initialisée', C.call(ADMIN, 'init', [OWN_PAY, COL_PAY, ADMIN, chO[40], chC[40]]).success);

const base = { ...process.env, CONTRACT: C.address, RPC_URL: mock.url, ACCOUNT: '', ASENTUM_BIN: '/nonexistent', CHAIN_LENGTH: '40', POLL_MS: '150',
  RECEIPT_TIMEOUT_MS: '15000', MAX_RUN_MS: '20000', TELEGRAM_TOKEN: 'x', TELEGRAM_CHAT_ID: '1', TELEGRAM_API: mock.url + '/__alert', ENV_FILE: '/nonexistent' };
const envO = { ...base, ROLE: 'owner', SIGNER_SEED: seedO, CHAIN_SEED: chO[0], DATA_DIR: mkdtempSync(join(tmpdir(), 'to-')) };
const envC = { ...base, ROLE: 'collab', SIGNER_SEED: seedC, CHAIN_SEED: chC[0], DATA_DIR: mkdtempSync(join(tmpdir(), 'tc-')) };
const once = (env) => new Promise((res) => {
  const p = spawn('node', [join(HERE, 'croupier.mjs'), 'once'], { env });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('exit', (code) => { if (process.env.VERBOSE) console.log(out); res({ code, out }); });
});
const warp = (to) => fetch(mock.url + '/__warp', { method: 'POST', body: JSON.stringify({ to }) });

// Semaine 1 : 2 wallets seulement → prolongation
C.call(players[0], 'buy', [4, ''], 20n * ASE); C.call(players[1], 'buy', [2, ''], 10n * ASE);
const r1 = C.view('getRound', [1]);
await warp(r1.closeTs + 1000);
const a = await once(envO);
t('2 participants : le croupier prolonge d\'une semaine', a.code === 0 && C.view('getRound', [1]).status === 'open' && C.view('getRound', [1]).weeks === 2, a.out.slice(-300));
// Semaine 2 : 5 wallets
for (let i = 2; i < 6; i++) C.call(players[i], 'buy', [1 + i, ''], BigInt(1 + i) * 5n * ASE);
await warp(C.view('getRound', [1]).closeTs + 1000);
const q1 = await once(envO);
t('passage owner : fermeture + secret owner', q1.code === 0 && !!C.view('getRound', [1]).sO, q1.out.slice(-300));
const q2 = await once(envC);
const r = C.view('getRound', [1]);
t('passage collab : 3 gagnants tirés', q2.code === 0 && r.status === 'done' && r.win.length === 3, q2.out.slice(-300));
const all = C.view('getPurchases', [1, 0, 400]).map((p) => ({ b: p.b, n: p.n, first: p.first }));
t('gagnants = référence indépendante', JSON.stringify(r.win) === JSON.stringify(ref.raffleWinners(1, r.sO, r.sC, r.digest, all)));
t('commission 75 / 25 reçue', mock.chain.balanceOf(OWN_PAY) === BigInt(r.commission) * 3n / 4n && mock.chain.balanceOf(COL_PAY) === BigInt(r.commission) - BigInt(r.commission) * 3n / 4n);
t('annonce Telegram des gagnants', mock.alerts.some((x) => x.includes('Tombola n°1') && x.includes('1er prix')), mock.alerts.join(' | ').slice(0, 300));
t('les prix attendent le Claim (non envoyés)', C.view('getState').owed === (BigInt(r.sales) - BigInt(r.commission)).toString());
const q3 = await once(envO);
t('passage suivant : rien à faire', q3.code === 0 && /0 transaction/.test(q3.out), q3.out.slice(-200));
const b = mock.chain.balanceOf(r.win[0].b);
t('le gagnant réclame son prix', C.call(r.win[0].b, 'claim', [1, 0]).success && mock.chain.balanceOf(r.win[0].b) - b === BigInt(r.prizes[0]));

mock.stop();
console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
