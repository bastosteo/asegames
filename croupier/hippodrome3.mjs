#!/usr/bin/env node
// =====================================================================
//  CROUPIER — Hippodrome ASE Vegas v3 (chevaux des joueurs), GitHub Actions
// =====================================================================
//  Deux contrats : ÉCURIE (chevaux, inscriptions, prime au propriétaire) et PARIS
//  (paris des spectateurs). Deux croupiers A et B, chacun avec SA graine secrète.
//  Chaque jour :
//   1. pose l'heure de la course (19 h Paris par défaut, réglage "hour" de l'Écurie) ;
//   2. à la clôture des inscriptions (1 h avant) : calcule les partants (inscrits +
//      chevaux de la maison) et les chances à partir de l'état des chevaux, puis
//      dépose son enveloppe sur l'Écurie ET sur les Paris (même graine, mêmes partants) ;
//   3. après le départ : révèle sa graine sur les deux contrats → même arrivée.
//  Variables : ROLE (A|B), ECURIE, PARIS, SIGNER_SEED, HIPPO_SEED, RPC_URL.
//  Commande : node croupier/hippodrome3.mjs once
// =====================================================================
import { createHash, createHmac, randomInt } from 'node:crypto';
import { makeSetup3, nextSlot } from '../hippodrome/js/stable.mjs';

const sha = (h) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex');
const u64 = (n) => BigInt(n).toString(16).padStart(16, '0');
export const seedFor = (secret, eid) => createHmac('sha256', Buffer.from(secret, 'hex')).update('hippodrome3|' + eid).digest('hex');
export const commitOf = (seed, raceId, addrHex) => sha(seed + u64(raceId) + addrHex.slice(2));
const log = (...a) => console.log(new Date().toISOString(), `[hippo3-${process.env.ROLE || '?'}]`, ...a);
const MIN = 60000;

// Une action à la fois ; renvoie true si une transaction a été envoyée.
//  api = { me, secret, nowMs(), view(k, method, args), send(k, method, args, valueWei), rand() }  k = 'E' | 'P'
export async function step(api) {
  const E = JSON.parse(await api.view('E', 'info', [])), P = JSON.parse(await api.view('P', 'info', []));
  const c = E.cfg, r = E.race, pr = P.race, me = api.me, now = api.nowMs();
  const slot = me === c.cA ? 'A' : me === c.cB ? 'B' : null;
  if (!slot) throw new Error(`ce compte (${me}) n'est pas un croupier de l'Écurie`);
  if (me !== P.cfg.croupierA && me !== P.cfg.croupierB) throw new Error(`ce compte (${me}) n'est pas un croupier des Paris`);
  const seed = (eid) => seedFor(api.secret, eid);

  // 1) révélations (même en pause : une course fermée doit être tirée)
  if (r.st === 'open' && now >= Number(r.at)) {
    const m = r.byA === me ? 'A' : r.byB === me ? 'B' : null;
    if (m && r['s' + m] === '') { log(`écurie course ${r.id} : révélation`); await api.send('E', 'reveal', [r.id, seed(r.id)], 0n); return true; }
  }
  if (pr.status === 'open' && now >= Number(pr.closeAt)) {
    const m = pr.byA === me ? 'A' : pr.byB === me ? 'B' : null;
    if (m && pr['seed' + m] === '') { log(`paris course ${pr.id} : révélation`); await api.send('P', 'reveal', [pr.id, seed(pr.info)], 0n); return true; }
  }
  // 2) course de l'Écurie abandonnée (délai dépassé) : annulation, inscriptions remboursées
  if ((r.st === 'entry' || r.st === 'open') && r.at !== '0' && now > Number(r.at) + Number(c.timeoutMs)) {
    log(`écurie course ${r.id} : délai dépassé, annulation`); await api.send('E', 'cancel', [r.id], 0n); return true;
  }
  if (c.paused) { log('écurie en pause'); return false; }
  // 3) heure de la course
  if (r.st === 'entry' && r.at === '0') {
    const at = nextSlot(now, Number(c.entryLead) + 15 * MIN, [Number(c.hour)]);
    log(`écurie course ${r.id} : départ ${new Date(at).toISOString()}`);
    await api.send('E', 'plan', [r.id, String(at)], 0n); return true;
  }
  // 4) enveloppe Écurie (avec les partants si je suis le premier)
  if (r.st === 'entry' && now >= Number(r.at) - Number(c.entryLead) && r['c' + slot] === '') {
    let setup = '';
    if (!r.set) {
      const horses = [];
      for (const e of r.en) horses.push(JSON.parse(await api.view('E', 'horse', [e.h])));
      setup = JSON.stringify(makeSetup3(horses, c, api.rand, now, Number(r.at)));
      log(`écurie course ${r.id} : partants ${setup}`);
    }
    await api.send('E', 'commit', [r.id, commitOf(seed(r.id), r.id, me), setup], BigInt(c.bond)); return true;
  }
  // 5) enveloppe Paris : mêmes partants, même graine que la course de l'Écurie
  if (pr.status === 'pending' && pr['commit' + slot] === '' && !P.cfg.paused) {
    if (pr.closeAt !== '0') {                         // l'autre croupier a déjà publié : on suit sa course
      log(`paris course ${pr.id} : enveloppe (écurie ${pr.info})`);
      await api.send('P', 'commit', [pr.id, commitOf(seed(pr.info), pr.id, me), '0', ''], BigInt(P.cfg.bond)); return true;
    }
    if (r.set && (r.st === 'entry' || r.st === 'open') && Number(r.at) > now + 11 * MIN) {
      const setup = JSON.stringify({ ...r.set, info: r.id });
      log(`paris course ${pr.id} : enveloppe + partants de l'écurie ${r.id}`);
      await api.send('P', 'commit', [pr.id, commitOf(seed(r.id), pr.id, me), r.at, setup], BigInt(P.cfg.bond)); return true;
    }
  }
  log(`écurie course ${r.id} : ${r.st}${r.at !== '0' ? ' départ ' + new Date(Number(r.at)).toISOString() : ''} · paris course ${pr.id} : ${pr.status}`);
  return false;
}

// --- Chaîne réelle : lecture RPC + signature directe (comme croupier.mjs) -------------------
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(v) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= G[i]; }
  return c >>> 0;
}
function toHex(a) {
  const s = String(a).trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(s)) return s;
  const d = [...s.slice(4)].map((ch) => B32.indexOf(ch));
  const hrp = [...'ase'].map((ch) => ch.charCodeAt(0));
  if (!s.startsWith('ase1') || d.some((x) => x < 0) || polymod([...hrp.map((ch) => ch >> 5), 0, ...hrp.map((ch) => ch & 31), ...d]) !== 1) throw new Error('adresse invalide : ' + a);
  let acc = 0, bits = 0; const out = [];
  for (const v of d.slice(0, -6)) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
  return '0x' + Buffer.from(out).toString('hex');
}

async function realApi() {
  const RPC = (process.env.RPC_URL || 'https://testnet.asentum.com').replace(/\/$/, '');
  const C2 = { E: toHex(process.env.ECURIE || ''), P: toHex(process.env.PARIS || '') };
  const secret = (process.env.HIPPO_SEED || '').trim().replace(/^0x/, '');
  const signer = (process.env.SIGNER_SEED || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('HIPPO_SEED manquante ou invalide');
  if (!/^[0-9a-f]{64}$/.test(signer)) throw new Error('SIGNER_SEED manquante ou invalide');
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const get = async (path, init) => {                     // le testnet renvoie parfois du HTML : on réessaie
    for (let i = 0; ; i++) {
      try { const r = await fetch(RPC + path, { ...init, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return JSON.parse(await r.text()); }
      catch (e) { if (i >= 4) throw e; await sleep(2000 * (i + 1)); }
    }
  };
  const C = await import('@asentum/crypto'), T = await import('@asentum/types');
  const kp = C.generateKeypair(Uint8Array.from(Buffer.from(signer, 'hex')));
  const me = C.addressFromPublicKey(kp.publicKey).toLowerCase();
  const chainId = BigInt((await get('/chain')).chainId);
  let lastBlockMs = Date.now();
  return {
    me, secret,
    nowMs: () => lastBlockMs,
    rand: () => randomInt(0, 2 ** 47) / 2 ** 47,
    async view(k, method, args) {
      const j = await get('/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract: C2[k], method, args }) });
      if (!j.ok) throw new Error(`view ${method} : ${j.reason || 'échec'}`);
      if (method === 'info' && k === 'E') lastBlockMs = Number(JSON.parse(j.returnValue).now);   // l'heure de la chaîne fait foi
      return j.returnValue;
    },
    async send(k, method, args, value) {
      for (let attempt = 1; attempt <= 6; attempt++) {
        const bal = await get('/balance/' + me);
        const body = { chainId, nonce: BigInt(bal.pendingNonce ?? bal.nonce), maxPriorityFeePerGas: 0n, maxFeePerGas: 10n, gasLimit: 2_000_000n,
          to: Uint8Array.from(Buffer.from(C2[k].slice(2), 'hex')), value, data: new TextEncoder().encode(JSON.stringify({ method, args })) };
        const signature = C.sign(C.blake3(T.TransactionBodySchema.serialize(body)), kp.secretKey);
        const rawTx = '0x' + Buffer.from(T.SignedTransactionSchema.serialize({ body, publicKey: kp.publicKey, signature })).toString('hex');
        const res = await fetch(RPC + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rawTx }), signal: AbortSignal.timeout(30000) })
          .then((x) => x.json()).catch((e) => ({ accepted: false, reason: e.message }));
        if (!res.accepted || !res.txHash) { log(`${method} : envoi refusé (${res.reason || '?'}), essai ${attempt}/6`); await sleep(/nonce/i.test(res.reason || '') ? 20000 : 5000 * attempt); continue; }
        log(`${method} envoyé : ${res.txHash}`);
        for (let t = 0; t < 60; t++) {
          await sleep(4000);
          const rc = await get('/receipts/' + res.txHash).catch(() => null);
          if (rc && rc.blockNumber) {
            if (rc.success) { log(`${method} confirmé (bloc ${rc.blockNumber}, gas ${rc.gasUsed})`); return rc; }
            throw new Error(`${method} refusé par le contrat : ${rc.error || 'raison inconnue'}`);
          }
        }
        log(`${method} : pas de reçu après 4 min, je relis l'état`);
        return null;
      }
      throw new Error(`${method} : impossible d'envoyer après 6 essais`);
    },
  };
}

if (process.argv[2] === 'once') {
  const api = await realApi();
  log(`compte croupier ${api.me}`);
  for (let k = 0; k < 4; k++) if (!(await step(api))) break;
}
