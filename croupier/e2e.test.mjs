// Test de bout en bout du croupier sur une fausse chaîne locale :
//   node croupier/e2e.test.mjs
// Scénario 1 : tirage normal (owner + collaborateur) → gains payés, commission versée.
// Scénario 2 : le collaborateur tombe → alerte, annulation après le délai, remboursements.
// Scénario 3 : le collaborateur revient → tirage suivant normal.
import { readFileSync, readdirSync, mkdtempSync, chmodSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockNode } from '../sim/mock-node.mjs';
import * as ref from '../contrat/ref.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = readFileSync(join(ROOT, 'contrat/loto.js'), 'utf8');
const FAKE = join(ROOT, 'sim/fake-asentum.mjs');
chmodSync(FAKE, 0o755);
const ASE = 10n ** 18n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log('  ✓', name); } else { ko++; console.log('  ✗', name, extra); } };

const mock = await startMockNode({ source: SRC, blockMs: 100 });
const ADMIN = '0x' + 'a'.repeat(40), OWN = '0x' + 'b'.repeat(40), COL = '0x' + 'c'.repeat(40);
const OWN_PAY = '0x' + 'd'.repeat(40), COL_PAY = '0x' + 'e'.repeat(40);
const DROP = '0x' + 'f'.repeat(40);   // contrat ASE Airdrop (cagnotte)
const players = Array.from({ length: 12 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
mock.addAccount('admin', ADMIN); mock.addAccount('croupier-owner', OWN); mock.addAccount('croupier-collab', COL);
players.forEach((p) => mock.addAccount(p, p));
const C = mock.contract;

// Chaque croupier crée SA chaîne dans son propre dossier.
const dirO = mkdtempSync(join(tmpdir(), 'own-')), dirC = mkdtempSync(join(tmpdir(), 'col-'));
const baseEnv = { ...process.env, CONTRACT: C.address, RPC_URL: mock.url, ASENTUM_BIN: FAKE, MOCK_URL: mock.url, CHAIN_LENGTH: '40',
  TICK_MS: '300', POLL_MS: '150', RECEIPT_TIMEOUT_MS: '15000', TELEGRAM_TOKEN: 'x', TELEGRAM_CHAT_ID: '1', TELEGRAM_API: mock.url + '/__alert',
  LATE_ALERT_MIN: '15', BACKUP_AFTER_MIN: '30', ENV_FILE: '/nonexistent' };
const envO = { ...baseEnv, ROLE: 'owner', ACCOUNT: 'croupier-owner', DATA_DIR: dirO };
const envC = { ...baseEnv, ROLE: 'collab', ACCOUNT: 'croupier-collab', DATA_DIR: dirC };
const tipOf = (out) => out.match(/\n([0-9a-f]{64})\n/)[1];
const tipO = tipOf(execFileSync('node', [join(HERE, 'croupier.mjs'), 'chain-new'], { env: envO }).toString());
const tipC = tipOf(execFileSync('node', [join(HERE, 'croupier.mjs'), 'chain-new'], { env: envC }).toString());
t('deux chaînes créées, bouts différents', tipO !== tipC && tipO.length === 64);

let r = C.call(ADMIN, 'init', [OWN_PAY, COL_PAY, COL, tipO, tipC, DROP]);
t('contrat initialisé avec les deux bouts', r.success, r.error);

function startCroupier(env, name) {
  const p = spawn('node', [join(HERE, 'croupier.mjs'), 'run'], { env });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`[${name} ERR] ${d}`));
  return p;
}
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await sleep(200); }
  console.log('    (délai dépassé :', label + ')');
  return false;
}
const view = (m, a = []) => C.view(m, a);
const buyRandom = (n) => {
  for (let i = 0; i < n; i++) {
    const p = players[i % players.length];
    const k = 1 + (i % 5);
    const g = Array.from({ length: k }, () => ref.randomGrid());
    const x = C.call(p, "buy", [g, i.toString(16)], 2n * ASE * BigInt(k));
    if (!x.success) throw new Error(x.error);
  }
};

// ---------------- Scénario 1 : tirage normal ----------------
console.log('Scénario 1 : tirage normal');
buyRandom(40);
const r1 = view('getRound', [1]);
await fetch(mock.url + '/__warp', { method: 'POST', body: JSON.stringify({ to: r1.closeTs - 20000 }) });
const pO = startCroupier(envO, 'owner'), pC = startCroupier(envC, 'collab');
// Les gains se réclament : le croupier ne les envoie pas ; chaque gagnant clique « Claim » (settle de son achat).
const claimAll = (id) => { for (const p of C.view('getPurchases', [id, 0, 400])) if (p.prize !== '0' && !p.paid) C.call(p.b, 'settle', [id, p.idx, 1]); };
const drawn1 = await waitFor(() => view('getRound', [1]).status === 'done', 60000, 'tour 1 tiré');
await sleep(3000);
const unpaid1 = C.view('getPurchases', [1, 0, 400]).filter((p) => p.prize !== '0');
t('le croupier n\'envoie pas les gains (ils attendent le Claim)', unpaid1.every((p) => !p.paid) && BigInt(view('getState').owed) === unpaid1.reduce((a, p) => a + BigInt(p.prize), 0n));
claimAll(1);
const done1 = drawn1 && view('getState').owed === '0';
t('tour 1 fermé, révélé (owner puis collab), compté, finalisé', view('getRound', [1]).status === 'done');
t('chaque gagnant a réclamé son gain (dettes = 0)', done1);
const rd1 = view('getRound', [1]);
t('numéros = référence indépendante', JSON.stringify(rd1.nums) === JSON.stringify(ref.drawNumbers(1, rd1.sO, rd1.sC, rd1.digest)));
const C1 = BigInt(rd1.commission), D1 = C1 / 2n, O1 = (C1 - D1) * 7500n / 10000n;
t('commission : moitié au contrat Airdrop', mock.chain.balanceOf(DROP) === D1);
t('commission owner reçue (75 % de l\'autre moitié)', mock.chain.balanceOf(OWN_PAY) === O1);
t('commission collab reçue (25 % de l\'autre moitié)', mock.chain.balanceOf(COL_PAY) === C1 - D1 - O1);
await waitFor(() => mock.alerts.some((a) => a.includes('Tirage n°1')), 5000, 'annonce');
t('annonce Telegram du tirage envoyée', mock.alerts.some((a) => a.includes('Tirage n°1')));
t('alerte de démarrage envoyée', mock.alerts.some((a) => a.includes('démarré')));

// ---------------- Scénario 2 : collaborateur en panne ----------------
console.log('Scénario 2 : le collaborateur tombe');
pC.kill();
const cur2 = view('getState').cur;
buyRandom(10);
const r2 = view('getRound', [cur2]);
await fetch(mock.url + '/__warp', { method: 'POST', body: JSON.stringify({ to: r2.closeTs + 1000 }) });
await waitFor(() => view('getRound', [cur2]).sO, 20000, 'owner révèle');
t('l\'owner a révélé son secret', !!view('getRound', [cur2]).sO);
await fetch(mock.url + '/__warp', { method: 'POST', body: JSON.stringify({ to: r2.closeTs + 16 * 60000 }) });
await waitFor(() => mock.alerts.some((a) => a.includes('collaborateur n\'est toujours pas révélé')), 10000, 'alerte retard');
t('alerte "secret collaborateur en retard" envoyée', mock.alerts.some((a) => a.includes('collaborateur n\'est toujours pas révélé')));
await fetch(mock.url + '/__warp', { method: 'POST', body: JSON.stringify({ to: r2.closeTs + 5 * 3600000 }) });
await new Promise((ok) => setTimeout(ok, 4000));
t('5 h plus tard : le tour attend toujours (jamais annulé)', view('getRound', [cur2]).status === 'closed');
t('l\'alerte dit que le tirage attend', mock.alerts.some((a) => a.includes('Le tirage attend')));

// ---------------- Scénario 3 : retour du collaborateur ----------------
console.log('Scénario 3 : le collaborateur revient');
const pC2 = startCroupier(envC, 'collab');
const cur3 = view('getState').cur;
buyRandom(15);
const r3 = view('getRound', [cur3]);
await fetch(mock.url + '/__warp', { method: 'POST', body: JSON.stringify({ to: r3.closeTs + 1000 }) });
const done3 = await waitFor(() => view('getRound', [cur2]).status === 'done' && view('getRound', [cur3]).status === 'done', 60000, 'tours 2 et 3') && (claimAll(cur2), claimAll(cur3), view('getState').owed === '0');
t(`tour en attente ${cur2} puis tour ${cur3} tirés et payés normalement`, done3);

pO.kill(); pC2.kill();

// ---------------- Scénario 4 : mode GitHub Actions ----------------
// Pas de CLI : chaque croupier signe lui-même (SIGNER_SEED) et recalcule sa chaîne (CHAIN_SEED).
// Comme le workflow : un passage "once" owner, puis collab, puis owner, sans aucun fichier local.
console.log('Scénario 4 : mode GitHub Actions (signature directe, passages "once")');
const { pathToFileURL } = await import('node:url');
const cry = await import(pathToFileURL(join(HERE, 'node_modules/@asentum/crypto/dist/index.js')).href);
const { randomBytes } = await import('node:crypto');
const seedO = randomBytes(32).toString('hex'), seedC = randomBytes(32).toString('hex');
const addrOf = (seed) => cry.addressFromPublicKey(cry.generateKeypair(Uint8Array.from(Buffer.from(seed, 'hex'))).publicKey).toLowerCase();
mock.chain.fund(addrOf(seedO), 10n * ASE); mock.chain.fund(addrOf(seedC), 10n * ASE);
const firstOf = (dir, role) => JSON.parse(readFileSync(join(dir, role + '-chain.json'), 'utf8')).values[0];
const ghBase = { ...baseEnv, ACCOUNT: '', ASENTUM_BIN: '/nonexistent', MAX_RUN_MS: '20000' };
const ghO = { ...ghBase, ROLE: 'owner', SIGNER_SEED: seedO, CHAIN_SEED: firstOf(dirO, 'owner'), DATA_DIR: mkdtempSync(join(tmpdir(), 'gho-')) };
const ghC = { ...ghBase, ROLE: 'collab', SIGNER_SEED: seedC, CHAIN_SEED: firstOf(dirC, 'collab'), DATA_DIR: mkdtempSync(join(tmpdir(), 'ghc-')) };
const once = (env) => new Promise((ok) => {
  const p = spawn('node', [join(HERE, 'croupier.mjs'), 'once'], { env });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('exit', (code) => { if (process.env.VERBOSE) console.log(out); ok({ code, out }); });
});
const cur4 = view('getState').cur;
buyRandom(25);
const r4 = view('getRound', [cur4]);
const q0 = await once(ghO);
t('passage avant la fermeture : rien à faire, sortie propre', q0.code === 0 && /0 transaction/.test(q0.out), q0.out.slice(-300));
await fetch(mock.url + '/__warp', { method: 'POST', body: JSON.stringify({ to: r4.closeTs + 1000 }) });
const q1 = await once(ghO);
t('passage owner : fermeture + secret owner révélé', q1.code === 0 && !!view('getRound', [cur4]).sO, q1.out.slice(-300));
const q2 = await once(ghC);
t('passage collab : secret collaborateur révélé', q2.code === 0 && !!view('getRound', [cur4]).sC, q2.out.slice(-300));
const q3 = await once(ghO);
t('passage owner : comptage et tirage terminés', q3.code === 0 && view('getRound', [cur4]).status === 'done', q3.out.slice(-400));
claimAll(cur4);
t('gains réclamés par les joueurs, rien ne reste dû', view('getState').owed === '0');
const rd4 = view('getRound', [cur4]);
t('numéros du mode GitHub = référence indépendante', JSON.stringify(rd4.nums) === JSON.stringify(ref.drawNumbers(cur4, rd4.sO, rd4.sC, rd4.digest)));
t('aucun fichier de chaîne utilisé (dossiers vides de chaîne)', !readdirSync(ghO.DATA_DIR).some((f) => f.includes('chain')));

mock.stop();
// solde final cohérent
const s = view('getState');
console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
