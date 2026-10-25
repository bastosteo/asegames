#!/usr/bin/env node
// =====================================================================
//  SENTINELLE — ASE Treasure : repère les nouveaux wallets des tricheurs
// =====================================================================
//  Ne bannit jamais rien : elle envoie une alerte Telegram avec les preuves,
//  et c'est l'admin qui décide (onglet Admin du trésor, « Banned wallets »).
//
//  Deux signaux :
//   1. LIEN DE FONDS — un wallet qui a reçu des ASE d'un wallet banni ou
//      surveillé, ou qui lui en a envoyé (transferts simples, lus sur
//      l'indexeur de l'explorateur), et qui joue au trésor. C'est ainsi que
//      Scarofsky a monté ses 4 wallets : financés par lui, gains reversés.
//   2. COORDINATION — deux wallets qui fouillent la même grille dans le même
//      bloc, sur les dernières cases possibles, sur au moins 3 grilles en
//      24 h : signature d'un bot multi-wallets, même financé autrement.
//
//  Réglages (environnement) : CONTRACT (trésor ; OLD_TREASURE en plus),
//  RPC_URL, EXPLORER_URL, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, DATA_DIR,
//  SENTINELLE_ADRESSES (wallets à surveiller en plus des bannis, séparés par
//  des virgules ; variable GitHub, pas dans le code public).
//  Commande : node croupier/sentinelle.mjs once
// =====================================================================
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIZE = 20, CELLS = 400;
const HOT = 3, DAY = 24 * 3600000;
export const answerAt = (cell, t) => {
  const d = Math.max(Math.abs((cell % SIZE) - (t % SIZE)), Math.abs(Math.floor(cell / SIZE) - Math.floor(t / SIZE)));
  return d === 0 ? 'T' : d <= HOT ? 'H' : 'C';
};

// --- Adresses (ase1… ↔ 0x…) ------------------------------------------
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(v) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= G[i]; }
  return c >>> 0;
}
const hrp = [...'ase'].map((c) => c.charCodeAt(0)), hrpx = [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31)];
export function toHex(a) {
  const s = String(a).trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(s)) return s;
  const d = [...s.slice(4)].map((c) => B32.indexOf(c));
  if (!s.startsWith('ase1') || d.some((x) => x < 0) || polymod([...hrpx, ...d]) !== 1) throw new Error('adresse invalide : ' + a);
  let acc = 0, bits = 0; const out = [];
  for (const v of d.slice(0, -6)) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
  return '0x' + Buffer.from(out).toString('hex');
}
export function toAse1(a) {
  const bytes = [...Buffer.from(toHex(a).slice(2), 'hex')];
  let acc = 0, bits = 0; const d = [];
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; d.push((acc >> bits) & 31); } }
  if (bits) d.push((acc << (5 - bits)) & 31);
  const p = polymod([...hrpx, ...d, 0, 0, 0, 0, 0, 0]) ^ 1;
  for (let i = 0; i < 6; i++) d.push((p >>> (5 * (5 - i))) & 31);
  return 'ase1' + d.map((x) => B32[x]).join('');
}

// --- 1. Liens de fonds -------------------------------------------------
// watch : Set d'adresses 0x ; txs : Map adresse surveillée → transactions (format de l'indexeur).
// Rend les contreparties (hors surveillés) des transferts simples, avec la preuve la plus ancienne.
const norm = (a) => { try { return toHex(a); } catch { return String(a).toLowerCase(); } };
export function fundLinks(watch, txs) {
  const links = new Map();
  for (const [w, rows] of txs) {
    for (const r of rows) {
      if (r.status !== 1 || r.method !== 'transfer' || !r.to_addr || BigInt(r.value || 0) === 0n) continue;
      const from = norm(r.from_addr), to = norm(r.to_addr);   // l'indexeur rend parfois des adresses ase1…
      const other = from === w ? to : from;
      if (watch.has(other)) continue;
      const l = links.get(other) || { addr: other, via: new Set(), proofs: [] };
      l.via.add(w);
      l.proofs.push({ hash: r.hash, ts: r.timestamp, dir: from === w ? 'reçu de' : 'envoyé à', who: w, ase: Number(BigInt(r.value) / 10n ** 15n) / 1000 });
      links.set(other, l);
    }
  }
  for (const l of links.values()) l.proofs.sort((a, b) => a.ts - b.ts);
  return links;
}

// --- 2. Coordination de fin de grille -----------------------------------
// grids : [{ g, digs }] de grilles TROUVÉES (la case trésor rend chaque réponse publique).
// Pour chaque grille : fouilles faites quand il restait au plus maxK cases possibles,
// regroupées par heure de bloc ; deux wallets différents dans le même bloc = une rencontre.
export function coordination(grids, { maxK = 6 } = {}) {
  const pairs = new Map();
  for (const { g, digs } of grids) {
    if (g.status !== 'found' || g.cell < 0) continue;
    const T = g.cell, known = [], dug = new Set(), late = [];
    for (const d of digs) {
      let K = 0;
      for (let x = 0; x < CELLS; x++) if (!dug.has(x) && known.every(([c, a]) => answerAt(c, x) === a)) K++;
      if (K <= maxK) late.push(d);
      known.push([d.c, answerAt(d.c, T)]); dug.add(d.c);
    }
    const byTs = new Map();
    for (const d of late) { if (!d.t) continue; const l = byTs.get(d.t) || new Set(); l.add(d.b); byTs.set(d.t, l); }
    const seen = new Set();
    for (const ws of byTs.values()) {
      const l = [...ws].sort();
      for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
        const k = l[i] + '|' + l[j];
        if (seen.has(k)) continue;
        seen.add(k);
        const p = pairs.get(k) || { a: l[i], b: l[j], grids: [] };
        p.grids.push(g.id);
        pairs.set(k, p);
      }
    }
  }
  return [...pairs.values()].sort((x, y) => y.grids.length - x.grids.length);
}

// --- Exécution ---------------------------------------------------------
export async function main() {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const RPC = (process.env.RPC_URL || 'https://testnet.asentum.com').replace(/\/$/, '');
  const EXP = (process.env.EXPLORER_URL || 'https://explorer.asentum.com').replace(/\/$/, '');
  const contracts = [process.env.CONTRACT, ...String(process.env.OLD_TREASURE || '').split(',')].map((x) => String(x || '').trim()).filter(Boolean);
  if (!contracts.length) throw new Error('CONTRACT (adresse du trésor) manquant');
  const dir = process.env.DATA_DIR || join(HERE, 'data-sentinelle');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'sentinelle.json');
  const S = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { alerted: {}, last: {}, links: {} };
  const save = () => { writeFileSync(file + '.tmp', JSON.stringify(S)); renameSync(file + '.tmp', file); };
  const log = (...a) => console.log(new Date().toISOString(), '[sentinelle]', ...a);

  const view = async (c, m, a = []) => {
    for (let k = 0; ; k++) {
      let j;
      try {
        const r = await fetch(RPC + '/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract: c, method: m, args: a }), signal: AbortSignal.timeout(20000) });
        j = JSON.parse(await r.text());
      } catch (e) { if (k >= 3) throw e; await new Promise((z) => setTimeout(z, 1500 * (k + 1))); continue; }   // réseau : on réessaie
      if (!j.ok) throw new Error(m + ' : ' + (j.reason || 'lecture impossible'));   // refus du contrat : inutile de réessayer
      return j.returnValue;
    }
  };
  const tg = async (text) => {
    log('ALERTE :', text.replace(/\n/g, ' | '));
    if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: '🛡️ Sentinelle ASE Vegas\n' + text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    }).catch((e) => log('Telegram injoignable :', e.message));
  };
  const link = (a) => `${EXP}/address/${toAse1(a)}`;
  const short = (a) => { const s = toAse1(a); return s.slice(0, 9) + '…' + s.slice(-5); };

  // Wallets surveillés = bannis (contrat) + liste en plus
  const banned = new Set(), watch = new Set();
  for (const c of contracts) { try { for (const b of await view(c, 'getBans')) banned.add(String(b.a).toLowerCase()); } catch {} }
  for (const a of String(process.env.SENTINELLE_ADRESSES || '').split(/[\s,;]+/).filter(Boolean)) { try { watch.add(toHex(a)); } catch { log('adresse ignorée :', a); } }
  for (const b of banned) watch.add(b);
  log(`${banned.size} bannis, ${watch.size} wallets surveillés`);

  // Joueurs du trésor sur 24 h (et grilles trouvées pour la coordination)
  const now = Date.now(), players = new Map(), found = [];
  for (const c of contracts) {
    let st; try { st = await view(c, 'getState'); } catch { continue; }
    for (let id = st.cur; id >= 1; id--) {
      const g = await view(c, 'getGrid', [id]);
      if (!g) continue;
      if (g.status !== 'open' && g.endTs < now - DAY) break;
      const digs = [];
      for (let k = 0; k < g.digs; k += 400) digs.push(...(await view(c, 'getDigs', [id, k, Math.min(400, g.digs - k)])));
      for (const d of digs) { const p = players.get(d.b) || { digs: 0, grids: new Set() }; p.digs++; p.grids.add(id); players.set(d.b, p); }
      if (g.status === 'found') found.push({ g, digs });
    }
  }
  log(`${players.size} joueurs, ${found.length} grilles trouvées en 24 h`);

  // 1. Liens de fonds : nouvelles transactions des surveillés (l'indexeur rend les plus récentes d'abord)
  const txs = new Map();
  for (const w of watch) {
    const rows = [];
    for (let p = 1; p <= 40; p++) {
      const r = await fetch(`${EXP}/api/indexer/address/${w}/txs?page=${p}&size=100`, { signal: AbortSignal.timeout(20000) }).catch(() => null);
      const t = r && r.ok ? await r.text() : '';
      if (!t.startsWith('{')) { log('indexeur injoignable pour', short(w)); break; }
      const j = JSON.parse(t);
      const stop = j.rows.findIndex((x) => x.hash === S.last[w]);
      rows.push(...(stop >= 0 ? j.rows.slice(0, stop) : j.rows));
      if (stop >= 0 || !j.rows.length || p * 100 >= j.total) break;
    }
    if (rows.length) S.last[w] = rows[0].hash;
    txs.set(w, rows);
  }
  for (const l of fundLinks(watch, txs).values()) {
    const old = S.links[l.addr] || { via: [], proofs: [] };
    S.links[l.addr] = { via: [...new Set([...old.via, ...l.via])], proofs: [...old.proofs, ...l.proofs].slice(0, 5) };
  }
  const fresh = [];
  for (const [a, l] of Object.entries(S.links)) {
    const p = players.get(a);
    if (!p || banned.has(a) || S.alerted['fonds:' + a]) continue;
    S.alerted['fonds:' + a] = now;
    fresh.push({ a, p, pr: l.proofs[0] });
  }
  const line = ({ a, p, pr }) => `• ${toAse1(a)} : ${p.digs} fouilles en 24 h ; ${pr.dir === 'reçu de' ? 'a reçu' : 'a envoyé'} ${pr.ase} ASE ${pr.dir === 'reçu de' ? 'de' : 'à'} ${short(pr.who)}${banned.has(pr.who) ? ' (banni)' : ' (surveillé)'} le ${new Date(pr.ts).toISOString().slice(0, 10)}\n  ${EXP}/tx/${pr.hash}`;
  // Un message par passage (pas de rafale) : les 15 premiers, puis le nombre restant.
  for (let i = 0; i < fresh.length; i += 15) {
    await tg(`Lien de fonds avec un wallet banni ou surveillé, et joue au trésor (${fresh.length} wallet${fresh.length > 1 ? 's' : ''}) :\n`
      + fresh.slice(i, i + 15).map(line).join('\n')
      + `\nÀ vérifier, puis bannir si c'est lui : onglet Admin du trésor → Banned wallets.`);
  }

  // 2. Coordination : 3 grilles ou plus en 24 h, avec au moins un wallet pas encore banni
  for (const p of coordination(found)) {
    if (p.grids.length < 3) break;
    if (banned.has(p.a) && banned.has(p.b)) continue;
    const key = 'coord:' + p.a + '|' + p.b;
    if (S.alerted[key] && now - S.alerted[key] < 7 * DAY) continue;
    S.alerted[key] = now;
    const tag = (a) => (banned.has(a) ? ' (banni)' : watch.has(a) ? ' (surveillé)' : '');
    await tg(`Bot multi-wallets probable : ${short(p.a)}${tag(p.a)} et ${short(p.b)}${tag(p.b)} fouillent dans le même bloc les dernières cases possibles, sur ${p.grids.length} grilles en 24 h (n° ${p.grids.slice(0, 8).join(', ')}).\n`
      + `${link(p.a)}\n${link(p.b)}\n`
      + `À vérifier, puis bannir si c'est lui : onglet Admin du trésor → Banned wallets.`);
  }
  save();
  log('terminé');
}

if (process.argv[2] === 'once') main().catch((e) => { console.error(e.message); process.exit(1); });
