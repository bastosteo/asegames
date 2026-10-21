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
const DROP = '0x' + 'f'.repeat(40);   // contrat ASE Airdrop (cagnotte)
const players = Array.from({ length: 8 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
players.forEach((p) => mock.chain.fund(p, 1000n * ASE)); mock.chain.fund(ADMIN, ASE);
const cry = await import(pathToFileURL(join(HERE, 'node_modules/@asentum/crypto/dist/index.js')).href);
const addrOf = (seed) => cry.addressFromPublicKey(cry.generateKeypair(Uint8Array.from(Buffer.from(seed, 'hex'))).publicKey).toLowerCase();
const seedO = randomBytes(32).toString('hex'), seedC = randomBytes(32).toString('hex');
mock.chain.fund(addrOf(seedO), 10n * ASE); mock.chain.fund(addrOf(seedC), 10n * ASE);
const chO = ref.makeChain(40), chC = ref.makeChain(40);
t('tombola initialisée', C.call(ADMIN, 'init', [OWN_PAY, COL_PAY, ADMIN, chO[40], chC[40], DROP]).success);

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

// Tirage 1 : 2 tickets seulement → tirage quand même, le 3e prix est reporté
C.call(players[0], 'buy', [1, ''], 5n * ASE); C.call(players[1], 'buy', [1, ''], 5n * ASE);
const r1 = C.view('getRound', [1]);
await warp(r1.closeTs + 1000);
const a1 = await once(envO), a2 = await once(envC);
const w1 = C.view('getRound', [1]);
t('2 participants : tirage fait, 2 gagnants', a1.code === 0 && a2.code === 0 && w1.status === 'done' && w1.win.length === 2, a2.out.slice(-300));
t('le 3e prix passe à la tombola 2', BigInt(w1.carryOut) > 0n && C.view('getRound', [2]).carryIn === w1.carryOut);
t('annonce : report mentionné', mock.alerts.some((x) => x.includes('Tombola n°1') && x.includes('reportés')));
// Tirage 2 : 5 wallets
for (let i = 2; i < 7; i++) C.call(players[i], 'buy', [1 + (i % 5), ''], BigInt(1 + (i % 5)) * 5n * ASE);
await warp(C.view('getRound', [2]).closeTs + 1000);
const q1 = await once(envO);
t('passage owner : fermeture + secret owner', q1.code === 0 && !!C.view('getRound', [2]).sO, q1.out.slice(-300));
const q2 = await once(envC);
const r = C.view('getRound', [2]);
t('passage collab : gagnants tirés (top 3 + petit lot)', q2.code === 0 && r.status === 'done' && r.win.length === r.prizes.length && r.win.length >= 3, q2.out.slice(-300));
const all = C.view('getPurchases', [2, 0, 400]);
t('tickets gagnants = référence indépendante', JSON.stringify(r.win) === JSON.stringify(ref.raffleTicketsV4(2, r.sO, r.sC, r.digest, r.tickets, r.prizes.length)));
{ const C1 = BigInt(w1.commission) + BigInt(r.commission), D = BigInt(w1.airdrop) + BigInt(r.airdrop);
  t('commission versée à chaque achat : 6 % Airdrop, reste équipe', D === C1 * 6n / 15n && mock.chain.balanceOf(DROP) === D && mock.chain.balanceOf(OWN_PAY) + mock.chain.balanceOf(COL_PAY) === C1 - D); }
t('cagnotte 2 = report + 85 % des ventes', r.prizes.reduce((a, x) => a + BigInt(x), 0n) === BigInt(w1.carryOut) + BigInt(r.sales) - BigInt(r.commission));
t('annonce Telegram des gagnants', mock.alerts.some((x) => x.includes('Tombola n°2') && x.includes('1er prix')), mock.alerts.join(' | ').slice(0, 300));
const q3 = await once(envO);
t('passage suivant : rien à faire', q3.code === 0 && /0 transaction/.test(q3.out), q3.out.slice(-200));
const p0 = all.find((p) => p.first <= r.win[0] && r.win[0] < p.first + p.n), b = mock.chain.balanceOf(p0.b);
t('le gagnant réclame son prix', C.call(p0.b, 'claim', [2, 0, p0.idx]).success && mock.chain.balanceOf(p0.b) - b === BigInt(r.prizes[0]));

mock.stop();
console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
