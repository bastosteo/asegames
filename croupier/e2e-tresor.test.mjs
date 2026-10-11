// Test de bout en bout d'ASE Treasure : croupier (mode GitHub) + service de réponses
// (Cloudflare Pages Function) sur une fausse chaîne locale.
//   node croupier/e2e-tresor.test.mjs
import { readFileSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startMockNode } from '../sim/mock-node.mjs';
import { board, verify } from '../functions/_lib/board.mjs';
import { onRequestGet } from '../functions/api/treasure.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASE = 10n ** 18n, PRICE = 5n * 10n ** 17n;
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log('  ✓', name); } else { ko++; console.log('  ✗', name, extra); } };

const mock = await startMockNode({ source: readFileSync(join(HERE, '..', 'contrat', 'tresor.js'), 'utf8'), blockMs: 100 });
const C = mock.contract;
const ADMIN = '0x' + 'a'.repeat(40), OWN = '0x' + 'd'.repeat(40), COL = '0x' + 'e'.repeat(40), DROP = '0x' + 'f'.repeat(40);
const P = Array.from({ length: 8 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
P.forEach((p) => mock.chain.fund(p, 100n * ASE));
const cry = await import(pathToFileURL(join(HERE, 'node_modules/@asentum/crypto/dist/index.js')).href);
const signer = randomBytes(32).toString('hex');
const OPER = cry.addressFromPublicKey(cry.generateKeypair(Uint8Array.from(Buffer.from(signer, 'hex'))).publicKey).toLowerCase();
mock.chain.fund(OPER, 10n * ASE);
const SEED = randomBytes(32).toString('hex');
t('contrat initialisé', C.call(ADMIN, 'init', [OPER, OWN, COL, DROP]).success);

const env = { ...process.env, GAME: 'treasure', CONTRACT: C.address, TREASURE_SEED: SEED, RPC_URL: mock.url, ACCOUNT: '', ASENTUM_BIN: '/nonexistent', POLL_MS: '150', ROLE: 'owner', SIGNER_SEED: signer,
  RECEIPT_TIMEOUT_MS: '15000', MAX_RUN_MS: '20000', TELEGRAM_TOKEN: 'x', TELEGRAM_CHAT_ID: '1', TELEGRAM_API: mock.url + '/__alert', ENV_FILE: '/nonexistent', DATA_DIR: mkdtempSync(join(tmpdir(), 'tr-')) };
const once = () => new Promise((res) => {
  const p = spawn('node', [join(HERE, 'croupier.mjs'), 'once'], { env });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('exit', (code) => { if (process.env.VERBOSE) console.log(out); res({ code, out }); });
});
const api = async (q) => { const r = await onRequestGet({ request: new Request('https://asevegas.pages.dev/api/treasure?' + q), env: { TREASURE_SEED: SEED, TREASURE_CONTRACT: C.address, RPC_URL: mock.url } }); return { status: r.status, j: await r.json() }; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const a = await once();
const g1 = C.view('getGrid', [1]);
const B = board(SEED, 1);
t('le croupier ouvre la grille 1 avec la bonne racine', a.code === 0 && g1 && g1.status === 'open' && g1.root === B.root, a.out.slice(-300));
const colds = B.cells.map((c, i) => [c.ans, i]).filter(([x]) => x !== 'T').map(([, i]) => i);
t('fouilles de 3 joueurs', C.call(P[0], 'dig', [1, colds[0]], PRICE).success && C.call(P[1], 'dig', [1, colds[1]], PRICE).success && C.call(P[2], 'dig', [1, colds[50]], PRICE).success);
let r = await api(`grid=1&cells=${colds[0]},${colds[1]},${colds[2]},${B.treasure}`);
t('le service ne répond que pour les cases fouillées', r.status === 200 && r.j.answers.length === 2 && r.j.answers.every((x) => [colds[0], colds[1]].includes(x.cell)), JSON.stringify(r.j).slice(0, 200));
t('chaque réponse a une preuve valide (racine du contrat)', r.j.answers.every((x) => verify(g1.root, 1, x.cell, x.ans, x.salt, x.proof) && x.ans === B.cells[x.cell].ans));
t('la position du trésor n\'est pas donnée', r.j.treasure === undefined);
t('grille entière refusée tant qu\'elle est ouverte', (await api('grid=1&all=1')).status === 403);
t('requête invalide refusée', (await api('grid=1&cells=400')).status === 400 && (await api('grid=abc')).status === 400);
t('un joueur fouille le trésor', C.call(P[3], 'dig', [1, B.treasure], PRICE).success);
const b0 = mock.chain.balanceOf(P[3]);
r = await api(`grid=1&cells=${B.treasure}`);
t('réponse immédiate : trésor', r.j.answers[0] && r.j.answers[0].ans === 'T');
t('un autre fouille juste après (sera remboursé)', C.call(P[4], 'dig', [1, colds[60]], PRICE).success);
const b4 = mock.chain.balanceOf(P[4]);
const q = await once();
const g = C.view('getGrid', [1]);
t('le croupier envoie la preuve : le gagnant est payé', q.code === 0 && g.status === 'found' && g.winner === P[3] && mock.chain.balanceOf(P[3]) - b0 === 4n * PRICE * 85n / 100n, q.out.slice(-400));
t('la fouille d\'après est remboursée', mock.chain.balanceOf(P[4]) - b4 === PRICE);
t('grille 2 ouverte dans le même passage', C.view('getState').cur === 2 && C.view('getGrid', [2]).root === board(SEED, 2).root);
t('annonce Telegram', mock.alerts.some((x) => x.includes('trésor trouvé')), mock.alerts.join(' | '));
r = await api('grid=1&all=1');
t('grille 1 révélée en entier après la fin', r.status === 200 && r.j.answers.length === 400 && r.j.treasure === B.treasure && r.j.answers.every((x) => verify(g.root, 1, x.cell, x.ans, x.salt, x.proof)));
const q2 = await once();
t('passage suivant : rien à faire', q2.code === 0 && /0 transaction/.test(q2.out), q2.out.slice(-200));
t('service mal réglé → 503', (await onRequestGet({ request: new Request('https://x/api/treasure?grid=1'), env: {} })).status === 503);

mock.stop();
console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
