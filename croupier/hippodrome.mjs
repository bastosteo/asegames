#!/usr/bin/env node
// =====================================================================
//  CROUPIER — Hippodrome ASE Vegas (GitHub Actions ou PC)
// =====================================================================
//  Deux croupiers, A et B, chacun avec SA graine secrète (HIPPO_SEED) :
//   - avant chaque course : dépose son enveloppe scellée (commit + caution).
//     Le premier des deux publie aussi les partants, le terrain, les chances
//     et les risques de chute, calculés à partir des courses passées ;
//   - après l'heure du départ : révèle sa graine. Avec les deux graines,
//     le contrat tire l'arrivée (et une éventuelle chute) et paie tout seul.
//  La graine de chaque course est dérivée de HIPPO_SEED : rien à stocker,
//  et l'autre croupier ne peut pas la deviner.
//
//  Variables : ROLE (A|B), CONTRACT, SIGNER_SEED (compte qui signe et paie
//  caution + gas), HIPPO_SEED (32 octets hexa), RPC_URL, HOURS (18,19,20,21,22).
//  Commande : node croupier/hippodrome.mjs once
// =====================================================================
import { createHash, createHmac, randomInt } from 'node:crypto';
import { makeSetup, nextSlot, RACE_HOURS } from '../hippodrome/js/stable.mjs';

const sha = (h) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex');
const u64 = (n) => BigInt(n).toString(16).padStart(16, '0');
export const seedFor = (secret, raceId) => createHmac('sha256', Buffer.from(secret, 'hex')).update('hippodrome|' + raceId).digest('hex');
export const commitOf = (seed, raceId, addrHex) => sha(seed + u64(raceId) + addrHex.slice(2));
const log = (...a) => console.log(new Date().toISOString(), `[hippodrome-${process.env.ROLE || '?'}]`, ...a);

// --- Une action à la fois ; renvoie true si quelque chose a été envoyé -----------------------
//  api = { me (0x…), secret, nowMs(), view(method,args), send(method,args,valueWei), rand() }
export async function step(api, opts = {}) {
  const hours = opts.hours || RACE_HOURS;
  const info = JSON.parse(await api.view('info', []));
  const c = info.cfg, id = BigInt(info.current), r = info.race, me = api.me;
  if (c.paused) { log('jeu en pause : rien à faire'); return false; }
  const slot = me === c.croupierA ? 'A' : me === c.croupierB ? 'B' : null;
  if (!slot) throw new Error(`ce compte (${me}) n'est pas un croupier du contrat`);
  const now = api.nowMs();

  // 1) course ouverte, heure passée, ma graine pas encore révélée → révéler
  if (r.status === 'open' && now >= Number(r.closeAt)) {
    const mine = r.byA === me ? 'A' : r.byB === me ? 'B' : null;
    if (mine && r['seed' + mine] === '') {
      log(`course ${id} : révélation de ma graine`);
      await api.send('reveal', [id.toString(), seedFor(api.secret, id)], 0n);
      return true;
    }
    log(`course ${id} : en attente de l'autre croupier`);
    return false;
  }
  // 2) course en préparation sans mon enveloppe → la déposer (avec le setup si je suis le premier)
  if (r.status === 'pending' && r['commit' + slot] === '') {
    let closeAt = '0', setup = '';
    if (r.closeAt === '0') {
      closeAt = String(nextSlot(now, 32 * 60000, hours));
      const races = [];
      for (let k = id - 1n; k >= 1n && k >= id - 40n; k--) races.push(JSON.parse(await api.view('race', [k.toString()])));
      setup = JSON.stringify(makeSetup(races, api.rand, c.minChance));
      log(`course ${id} : départ ${new Date(Number(closeAt)).toISOString()}, partants ${setup}`);
    }
    await api.send('commit', [id.toString(), commitOf(seedFor(api.secret, id), id, me), closeAt, setup], BigInt(c.bond));
    return true;
  }
  if (r.status === 'open') log(`course ${id} : paris ouverts jusqu'à ${new Date(Number(r.closeAt)).toISOString()}`);
  else log(`course ${id} : ${r.status}, rien à faire`);
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
  const CONTRACT = toHex(process.env.CONTRACT || '');
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
    async view(method, args) {
      const j = await get('/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract: CONTRACT, method, args }) });
      if (!j.ok) throw new Error(`view ${method} : ${j.reason || 'échec'}`);
      if (method === 'info') lastBlockMs = Number(JSON.parse(j.returnValue).now);   // l'heure de la chaîne fait foi
      return j.returnValue;
    },
    async send(method, args, value) {
      for (let attempt = 1; attempt <= 6; attempt++) {
        const bal = await get('/balance/' + me);
        const body = { chainId, nonce: BigInt(bal.pendingNonce ?? bal.nonce), maxPriorityFeePerGas: 0n, maxFeePerGas: 10n, gasLimit: 2_000_000n,
          to: Uint8Array.from(Buffer.from(CONTRACT.slice(2), 'hex')), value, data: new TextEncoder().encode(JSON.stringify({ method, args })) };
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
  const hours = (process.env.HOURS || '').split(',').map(Number).filter((h) => h >= 0 && h < 24);
  const api = await realApi();
  log(`compte croupier ${api.me}`);
  for (let k = 0; k < 3; k++) if (!(await step(api, { hours: hours.length ? hours : undefined }))) break;
}
