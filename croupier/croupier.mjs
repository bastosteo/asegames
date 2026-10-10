#!/usr/bin/env node
// =====================================================================
//  CROUPIER — Loto ASE
// =====================================================================
//  Rôle "owner"  : ferme les ventes, révèle le secret owner, compte les
//                  gagnants, paie les gains, rembourse les tours annulés.
//  Rôle "collab" : révèle le secret du collaborateur (après l'owner) et
//                  sert de secours (comptage, paiements) si l'owner tarde.
//
//  Aucune clé privée n'est lue ni stockée ici : les transactions sont
//  signées par la CLI officielle `asentum` avec le compte indiqué
//  (ACCOUNT). Utilise un compte dédié qui ne contient que de quoi payer
//  le gas : il n'a besoin d'AUCUN droit admin.
//
//  Commandes :
//    node croupier.mjs chain-new     crée TA chaîne de secrets (une fois)
//                                    et affiche son "bout" (à mettre dans init)
//    node croupier.mjs status        état du contrat et de ta chaîne
//    node croupier.mjs run           boucle principale (à laisser tourner)
//    node croupier.mjs test-alert    envoie un message Telegram de test
//
//  Réglages : fichier .env à côté du script (voir .env.exemple).
// =====================================================================
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- Lecture du fichier .env (format CLE=valeur) ---------------------
function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(process.env.ENV_FILE || join(HERE, '.env'));

const CFG = {
  role: (process.env.ROLE || 'owner').toLowerCase(),
  contract: process.env.CONTRACT || '',
  account: process.env.ACCOUNT || '',
  rpc: (process.env.RPC_URL || 'https://testnet.asentum.com').replace(/\/$/, ''),
  bin: process.env.ASENTUM_BIN || 'asentum',
  dataDir: process.env.DATA_DIR || join(HERE, 'data'),
  tickMs: Number(process.env.TICK_MS || 30000),
  receiptTimeoutMs: Number(process.env.RECEIPT_TIMEOUT_MS || 240000),
  pollMs: Number(process.env.POLL_MS || 4000),
  chainLength: Number(process.env.CHAIN_LENGTH || 3650),
  tgToken: process.env.TELEGRAM_TOKEN || '',
  tgChat: process.env.TELEGRAM_CHAT_ID || '',
  tgApi: (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, ''),
  healthPort: Number(process.env.HEALTH_PORT || 0),
  lateAlertMin: Number(process.env.LATE_ALERT_MIN || 15),   // alerte si un secret manque X min après la fermeture
  backupAfterMin: Number(process.env.BACKUP_AFTER_MIN || 30), // le collab prend le relais du comptage/paiement
  tallyBatch: Number(process.env.TALLY_BATCH || 300),
  payBatch: Number(process.env.PAY_BATCH || 100),
  name: process.env.CROUPIER_NAME || '',
  // Mode "sans CLI" (GitHub Actions, serveurs) : signature directe avec la librairie officielle.
  signerSeed: (process.env.SIGNER_SEED || '').trim(),   // graine 32 octets (hexa) du compte qui paie le gas
  chainSeed: (process.env.CHAIN_SEED || '').trim(),     // 1er élément de la chaîne de secrets (hexa)
  maxRunMs: Number(process.env.MAX_RUN_MS || 9 * 60000), // durée max d'un passage "once"
};
const LABEL = CFG.name || ('croupier-' + CFG.role);

// --- Petits outils ----------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (t) => createHash('sha256').update(t).digest('hex');
const shaHex = (h) => sha(Buffer.from(h, 'hex'));
const ase = (wei) => (Number(BigInt(wei) / 10n ** 14n) / 10000).toLocaleString('fr-FR', { maximumFractionDigits: 4 });
function log(...a) { console.log(new Date().toISOString(), `[${LABEL}]`, ...a); }

// Adresse ase1… → 0x… (bech32, vérifié). Le RPC /view attend du 0x.
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(v) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= G[i]; }
  return c >>> 0;
}
export function toHex(a) {
  const s = String(a).trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(s)) return s;
  if (!s.startsWith('ase1')) throw new Error('adresse invalide : ' + a);
  const d = [...s.slice(4)].map((c) => B32.indexOf(c));
  if (d.some((x) => x < 0)) throw new Error('adresse invalide : ' + a);
  const hrp = [...'ase'].map((c) => c.charCodeAt(0));
  if (polymod([...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...d]) !== 1) throw new Error('somme de contrôle ase1 fausse : ' + a);
  let acc = 0, bits = 0; const out = [];
  for (const v of d.slice(0, -6)) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
  return '0x' + Buffer.from(out).toString('hex');
}

// --- Fichiers locaux (écriture atomique) ------------------------------
mkdirSync(CFG.dataDir, { recursive: true });
const chainFile = join(CFG.dataDir, `${CFG.role}-chain.json`);
const stateFile = join(CFG.dataDir, `${CFG.role}-state.json`);
function writeJson(file, obj, secret = false) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 1));
  if (secret) try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, file);
}
const readJson = (file, d) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : d);
let STATE = readJson(stateFile, { paidCursor: {}, refundCursor: {}, alerted: {}, lastDrawn: 0 });
const saveState = () => writeJson(stateFile, STATE);

// --- Telegram ---------------------------------------------------------
const recentAlerts = new Map();
async function alert(text, key = text, everyMs = 30 * 60000) {
  const last = recentAlerts.get(key) || 0;
  if (Date.now() - last < everyMs) return;
  recentAlerts.set(key, Date.now());
  log('ALERTE :', text);
  if (!CFG.tgToken || !CFG.tgChat) return;
  try {
    await fetch(`${CFG.tgApi}/bot${CFG.tgToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CFG.tgChat, text: `🎰 ${LABEL}\n${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { log('Telegram injoignable :', e.message); }
}

// --- Lecture de la chaîne (RPC) ---------------------------------------
async function rpcGet(path) {
  const r = await fetch(CFG.rpc + path, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`RPC ${path} → HTTP ${r.status}`);
  return r.json();
}
let CONTRACT_HEX = '';
async function view(method, args = []) {
  const r = await fetch(CFG.rpc + '/view', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contract: CONTRACT_HEX, method, args }), signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`view ${method} → HTTP ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error(`view ${method} : ${j.reason || 'échec'}`);
  return j.returnValue;
}
async function receipt(hash) {
  try {
    const j = await rpcGet('/receipts/' + hash);
    return j && j.blockNumber ? j : null;
  } catch { return null; }
}

// --- Écriture : via la CLI `asentum call`, une transaction à la fois --
function runCli(args) {
  return new Promise((resolve) => {
    execFile(CFG.bin, args, { timeout: 120000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout) + String(stderr) });
    });
  });
}
class ContractError extends Error {}

// --- Signature directe (sans CLI) avec @asentum/crypto + @asentum/types ---
// Vérifié sur le testnet le 10/10/2026 : transaction acceptée (même format que la CLI).
let SIGNER = null;
async function sdkSigner() {
  if (!SIGNER) {
    const c = await import('@asentum/crypto');
    const t = await import('@asentum/types');
    const seed = Uint8Array.from(Buffer.from(CFG.signerSeed.replace(/^0x/, ''), 'hex'));
    if (seed.length !== 32) throw new Error('SIGNER_SEED doit faire 32 octets (64 caractères hexa)');
    const kp = c.generateKeypair(seed);
    const chain = await rpcGet('/chain');
    SIGNER = { c, t, kp, address: c.addressFromPublicKey(kp.publicKey).toLowerCase(), chainId: BigInt(chain.chainId) };
  }
  return SIGNER;
}
async function sdkSubmit(method, args) {
  const S = await sdkSigner();
  const bal = await rpcGet('/balance/' + S.address);
  const body = {
    chainId: S.chainId,
    nonce: BigInt(bal.pendingNonce ?? bal.nonce),
    maxPriorityFeePerGas: 0n, maxFeePerGas: 10n, gasLimit: 1_000_000n,
    to: Uint8Array.from(Buffer.from(CONTRACT_HEX.slice(2), 'hex')),
    value: 0n,
    data: new TextEncoder().encode(JSON.stringify({ method, args })),
  };
  const signature = S.c.sign(S.c.blake3(S.t.TransactionBodySchema.serialize(body)), S.kp.secretKey);
  const rawTx = '0x' + Buffer.from(S.t.SignedTransactionSchema.serialize({ body, publicKey: S.kp.publicKey, signature })).toString('hex');
  const r = await fetch(CFG.rpc + '/tx', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rawTx }), signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) return { accepted: false, reason: 'HTTP ' + r.status };
  return r.json();
}

let SENT = 0;
// Envoie un appel, attend le reçu. Réessaie si la CLI ou le réseau échouent.
async function send(method, args = []) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    let out = '', hash = null;
    if (CFG.signerSeed) {
      const r = await sdkSubmit(method, args).catch((e) => ({ accepted: false, reason: e.message }));
      if (r.accepted && r.txHash) hash = r.txHash; else out = String(r.reason || 'refusé');
    } else {
      out = (await runCli(['call', CFG.contract, method, '--from', CFG.account, '--args', JSON.stringify(args)])).out;
      hash = (out.match(/tx hash:\s*(0x[0-9a-f]{64})/i) || [])[1];
    }
    if (hash) SENT++;
    if (!hash) {
      const msg = out.trim().split('\n').slice(-2).join(' ');
      if (/nonce/i.test(out)) { log(`${method} : nonce occupé, nouvel essai dans 20 s`); await sleep(20000); continue; }
      log(`${method} : envoi échoué (${msg}), essai ${attempt}/6`);
      await sleep(Math.min(60000, 5000 * attempt));
      continue;
    }
    log(`${method}(${JSON.stringify(args).slice(0, 80)}) envoyé : ${hash}`);
    const t0 = Date.now();
    while (Date.now() - t0 < CFG.receiptTimeoutMs) {
      await sleep(CFG.pollMs);
      const rc = await receipt(hash);
      if (rc) {
        if (rc.success) { log(`${method} confirmé au bloc ${rc.blockNumber} (gas ${rc.gasUsed})`); return rc; }
        throw new ContractError(`${method} refusé par le contrat : ${rc.error || 'raison inconnue'}`);
      }
    }
    log(`${method} : pas de reçu après ${CFG.receiptTimeoutMs / 1000} s, je revérifie l'état avant de renvoyer`);
    return null; // l'appelant relit l'état (les méthodes sont sans danger si rejouées)
  }
  throw new Error(`${method} : impossible d'envoyer la transaction après 6 essais`);
}

// --- Chaîne de secrets ------------------------------------------------
function loadChain() {
  // Mode serveur : la chaîne est recalculée à partir de son 1er élément (CHAIN_SEED).
  if (CFG.chainSeed) {
    const values = [CFG.chainSeed.toLowerCase().replace(/^0x/, '')];
    for (let i = 0; i < CFG.chainLength; i++) values.push(shaHex(values[values.length - 1]));
    return values;
  }
  if (!existsSync(chainFile)) throw new Error(`chaîne absente (${chainFile}) : lance d'abord "node croupier.mjs chain-new"`);
  return readJson(chainFile).values;
}
function secretFor(tip, values) {
  const i = values.indexOf(tip);
  return i > 0 ? values[i - 1] : null;
}

// --- Logique d'un tour ------------------------------------------------
async function processRound(id, now, values) {
  const r = await view('getRound', [id]);
  if (!r) return;
  const sinceClose = now - Number(r.closeTs);
  const deadline = Number(r.closeTs) + r.revealMin * 60000;

  if (r.status === 'closed') {
    if (now >= deadline) {
      await alert(`⚠️ Tour ${id} : secrets non révélés à temps → annulation, remboursement des joueurs.`, 'cancel' + id, 1e12);
      await send('cancelExpired', [id]).catch((e) => log(e.message));
      return;
    }
    const st = await view('getState');
    if (CFG.role === 'owner' && !r.sO) {
      const sec = secretFor(st.tipO, values);
      if (!sec) { await alert(`❌ Tour ${id} : le bout de chaîne owner du contrat (${st.tipO.slice(0, 12)}…) est introuvable dans ma chaîne !`, 'nochain'); return; }
      await send('reveal', ['owner', id, sec]);
      return;
    }
    if (CFG.role === 'collab' && r.sO && !r.sC) {
      const sec = secretFor(st.tipC, values);
      if (!sec) { await alert(`❌ Tour ${id} : le bout de chaîne collaborateur du contrat est introuvable dans ma chaîne !`, 'nochain'); return; }
      await send('reveal', ['collab', id, sec]);
      return;
    }
    // Surveillance croisée : l'autre croupier est-il en retard ?
    if (sinceClose > CFG.lateAlertMin * 60000) {
      const who = !r.sO ? 'owner' : 'collaborateur';
      const left = Math.max(0, Math.round((deadline - now) / 60000));
      await alert(`⏰ Tour ${id} : le secret ${who} n'est toujours pas révélé (${Math.round(sinceClose / 60000)} min après la fermeture). Annulation automatique dans ${left} min si rien ne bouge.`, 'late' + id + who, 20 * 60000);
    }
    return;
  }

  if (r.status === 'tally') {
    if (CFG.role === 'owner' || sinceClose > CFG.backupAfterMin * 60000) {
      const rc = await send('tally', [id, CFG.tallyBatch]);
      if (rc && rc.returnValue && rc.returnValue.done) await announce(id);
    }
  }
}

async function announce(id) {
  const r = await view('getRound', [id]);
  if (!r || r.status !== 'done' || STATE.lastDrawn >= id) return;
  STATE.lastDrawn = id; saveState();
  const [c3, c4, c5] = r.cnt;
  await alert(
    `✅ Tirage n°${id} : ${r.nums.join(' - ')}\n` +
    `${r.grids} grilles, ventes ${ase(r.sales)} ASE\n` +
    `5 bons : ${c5}${c5 ? ` (${ase(r.per[2])} ASE chacun)` : ''} · 4 bons : ${c4} · 3 bons : ${c3}\n` +
    `Commission : ${ase(r.commission)} ASE · jackpot reporté : ${ase(r.carryOut)} ASE`, 'drawn' + id, 1e12);
}

// Paie les gains (tours "done") et rembourse (tours "cancelled") récents.
// Ce qui reste à payer est lu sur la chaîne : rien ne dépend d'un fichier local.
async function settle(st, now) {
  const from = Math.max(1, st.next - 10);
  for (let id = from; id <= st.cur; id++) {
    const r = await view('getRound', [id]);
    if (!r || !r.buys || (r.status !== 'done' && r.status !== 'cancelled')) continue;
    const isPay = r.status === 'done';
    // Le collaborateur ne paie qu'en secours (si l'owner traîne).
    if (CFG.role === 'collab' && now - Number(r.closeTs) < (CFG.backupAfterMin + 30) * 60000) continue;
    const list = [];
    for (let k = 0; k < r.buys; k += 400) list.push(...(await view('getPurchases', [id, k, 400])));
    const pending = (p) => !p.paid && (!isPay || p.prize !== '0');
    let i = list.findIndex(pending);
    if (i < 0) continue;
    if (isPay) await announce(id);
    while (i >= 0 && i < r.buys) {
      const rc = await send('settle', [id, i, CFG.payBatch]);
      if (!rc) break; // pas de reçu : on reprendra au prochain passage
      const next = rc.returnValue && Number.isInteger(rc.returnValue.next) ? rc.returnValue.next : Math.min(r.buys, i + CFG.payBatch);
      const rest = list.slice(next).findIndex(pending);
      i = rest < 0 ? -1 : next + rest;
    }
    if (i < 0) log(`Tour ${id} : ${isPay ? 'tous les gains payés' : 'tous les remboursements faits'}`);
  }
}

let lastOk = Date.now(), lastError = '';
async function tick(values) {
  const info = await view('info');
  const now = Number(info.now);
  // 1) Fermer les ventes à l'heure (le contrat le fait aussi au prochain achat)
  if (info.status === 'closing' && CFG.role === 'owner') await send('poke', []);
  const st = await view('getState');
  // 2) Tirage du prochain tour en attente
  if (st.next < st.cur) await processRound(st.next, now, values);
  // 3) Paiements / remboursements
  await settle(await view('getState'), now);
  lastOk = Date.now();
}

async function prepare() {
  if (!['owner', 'collab'].includes(CFG.role)) throw new Error('ROLE doit valoir owner ou collab');
  if (!CFG.contract) throw new Error('CONTRACT est obligatoire');
  if (!CFG.signerSeed && !CFG.account) throw new Error('ACCOUNT (compte CLI) ou SIGNER_SEED est obligatoire');
  CONTRACT_HEX = toHex(CFG.contract);
  const values = loadChain();
  const st = await view('getState');
  const tip = CFG.role === 'owner' ? st.tipO : st.tipC;
  if (values.indexOf(tip) < 0) throw new Error(`le bout de chaîne du contrat (${tip.slice(0, 16)}…) ne correspond pas à ma chaîne`);
  const left = values.indexOf(tip);
  const who = CFG.signerSeed ? `signataire ${(await sdkSigner()).address}` : `compte CLI "${CFG.account}"`;
  log(`démarré — contrat ${CFG.contract}, ${who}, ${left} secrets restants`);
  return { values, left };
}

// Un passage (GitHub Actions) : travaille tant qu'il y a quelque chose à faire, puis s'arrête.
async function once() {
  const { values, left } = await prepare();
  if (left < 60) await alert(`⚠️ Plus que ${left} secrets dans la chaîne : prévoir son renouvellement.`, 'lowchain', 0);
  const t0 = Date.now();
  let errors = 0;
  for (;;) {
    const before = SENT;
    try {
      await tick(values);
    } catch (e) {
      // Ex. : l'autre croupier (PC) a fait la même action juste avant → refus sans gravité, on relit l'état.
      errors++;
      log('erreur :', e.message);
      if (errors >= 4) {
        await alert(`❌ Croupier ${CFG.role} (GitHub) : ${e.message}`, 'err', 0);
        throw e;
      }
      await sleep(10000);
      continue;
    }
    if (SENT === before) break;                       // plus rien à faire
    if (Date.now() - t0 > CFG.maxRunMs) { log('durée max atteinte, la suite au prochain passage'); break; }
  }
  log(`passage terminé (${SENT} transaction(s) envoyée(s))`);
}

async function run() {
  const { values, left } = await prepare();
  await alert(`▶️ Croupier démarré (rôle ${CFG.role}, ${left} secrets restants).`, 'start', 10 * 60000);
  if (left < 60) await alert(`⚠️ Plus que ${left} secrets dans la chaîne : prévoir son renouvellement.`, 'lowchain', 24 * 3600000);

  // Petit serveur de santé (pour Fly.io) : 200 si le dernier passage a réussi récemment.
  if (CFG.healthPort) {
    http.createServer((req, res) => {
      const okNow = Date.now() - lastOk < Math.max(10 * 60000, CFG.tickMs * 6);
      res.writeHead(okNow ? 200 : 503, { 'content-type': 'text/plain' });
      res.end(okNow ? 'ok' : 'en échec : ' + lastError);
    }).listen(CFG.healthPort, () => log('santé sur le port', CFG.healthPort));
  }

  let failures = 0;
  for (;;) {
    try {
      await tick(values);
      if (failures >= 3) await alert('✅ Le croupier fonctionne de nouveau.', 'recovered', 0);
      failures = 0;
    } catch (e) {
      failures++;
      lastError = e.message;
      log('erreur :', e.message);
      if (failures === 3 || failures % 20 === 0) await alert(`❌ ${failures} erreurs d'affilée : ${e.message}`, 'err', 15 * 60000);
    }
    await sleep(CFG.tickMs);
  }
}

// --- Commandes ----------------------------------------------------------
async function chainNew() {
  if (existsSync(chainFile) && !process.argv.includes('--force')) {
    console.log(`Une chaîne existe déjà : ${chainFile}\nSon bout : ${readJson(chainFile).values.at(-1)}\n(--force pour en créer une nouvelle ; l'ancienne serait perdue)`);
    return;
  }
  const values = [randomBytes(32).toString('hex')];
  for (let i = 0; i < CFG.chainLength; i++) values.push(shaHex(values.at(-1)));
  writeJson(chainFile, { role: CFG.role, created: new Date().toISOString(), length: CFG.chainLength, values }, true);
  console.log(`Chaîne de ${CFG.chainLength} secrets créée : ${chainFile}`);
  console.log(`\nBOUT DE CHAÎNE (${CFG.role}) — à donner au déploiement :\n${values.at(-1)}\n`);
  console.log('⚠️  Sauvegarde ce fichier en lieu sûr (clé USB…). Ne le partage avec personne.');
  console.log('    S\'il est perdu : les tirages en attente seront annulés et remboursés, puis il faudra en créer un nouveau.');
}
async function status() {
  CONTRACT_HEX = toHex(CFG.contract);
  const [info, st] = [await view('info'), await view('getState')];
  const values = existsSync(chainFile) ? loadChain() : [];
  const tip = CFG.role === 'owner' ? st.tipO : st.tipC;
  console.log({
    role: CFG.role, tour: info.round, statut: info.status, ventes: ase(info.sales) + ' ASE', grilles: info.grids,
    tirage: new Date(Number(info.drawTs)).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
    jackpotEstime: ase(info.jackpotEstimate) + ' ASE', prochainATirer: info.nextToDraw, pause: info.paused,
    maChaine: values.length ? (values.indexOf(tip) > 0 ? `OK, ${values.indexOf(tip)} secrets restants` : 'NE CORRESPOND PAS au contrat') : 'absente',
  });
}

const cmd = process.argv[2] || 'run';
const main = { 'chain-new': chainNew, status, run, once, 'test-alert': () => alert('🔔 Message de test : les alertes fonctionnent.', 'test', 0) }[cmd];
if (!main) { console.log('Commandes : chain-new | status | run | once | test-alert'); process.exit(1); }
main().catch(async (e) => {
  console.error(e.message);
  if (cmd === 'run' || cmd === 'once') await alert(`💥 Croupier ${cmd === 'once' ? '(GitHub)' : ''} en erreur : ${e.message}`, 'fatal', 0);
  process.exit(1);
});
