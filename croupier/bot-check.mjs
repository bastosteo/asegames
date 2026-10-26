// Contrôle quotidien anti-bot du Treasure (lecture seule, aucune transaction).
// Analyse les cartes terminées sur les dernières 24 h et envoie un résumé Telegram.
//   TREASURE_CONTRACT=ase1… TELEGRAM_TOKEN=… TELEGRAM_CHAT_ID=… node croupier/bot-check.mjs
// Signes d'un bot : plusieurs fouilles dans les 10 s qui suivent la fouille gagnante (fouilles envoyées
// par paquets, avant de connaître le résultat), rafales de 3 fouilles ou plus en 10 s, et victoires
// répétées avec très peu de fouilles arrivées en fin de carte.
import { toAse1, toHex } from '../site/js/lotomath.js';
const RPC = (process.env.RPC_URL || 'https://testnet.asentum.com').replace(/\/$/, '');
const T = process.env.TREASURE_CONTRACT || '';
const HOURS = Number(process.env.BOTCHECK_HOURS || 24);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function view(method, args = []) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RPC + '/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract: toHex(T), method, args }), signal: AbortSignal.timeout(20000) });
      const j = JSON.parse(await r.text());
      if (!j.ok) throw new Error(method + ' : ' + (j.reason || 'échec'));
      return j.returnValue;
    } catch (e) { if (i >= 4) throw e; await sleep(2000 * (i + 1)); }
  }
}
async function send(text) {
  console.log(text);
  if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) { console.log('(Telegram non configuré : message affiché seulement)'); return; }
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!r.ok) console.log('Telegram a refusé :', r.status, await r.text());
}

if (!T) { console.log('TREASURE_CONTRACT manquant'); process.exit(0); }
const st = await view('getState');
const now = Date.now(), from = now - HOURS * 3600000;
const W = new Map();   // wallet → stats
const w = (b) => { if (!W.has(b)) W.set(b, { maps: 0, digs: 0, wins: 0, prize: 0n, afterWin: 0, bursts: 0, lateWins: 0 }); return W.get(b); };
let maps = 0, digsTot = 0;
for (let id = st.cur; id >= 1; id--) {
  const g = await view('getGrid', [id]);
  if (!g) continue;
  if (g.status !== 'found') { if (g.status === 'open') continue; }
  if (Number(g.endTs || 0) && Number(g.endTs) < from) break;
  if (g.status !== 'found' || !g.digs) continue;
  const d = [];
  for (let k = 0; k < g.digs; k += 400) d.push(...(await view('getDigs', [id, k, Math.min(400, g.digs - k)])));
  maps++; digsTot += d.length;
  const seen = new Set();
  for (const x of d) { const s = w(x.b); s.digs++; if (!seen.has(x.b)) { seen.add(x.b); s.maps++; } }
  // rafales : 3 fouilles ou plus du même wallet en 10 s
  const byW = new Map();
  d.forEach((x) => { if (!byW.has(x.b)) byW.set(x.b, []); byW.get(x.b).push(Number(x.t)); });
  for (const [b, ts] of byW) for (let i = 2; i < ts.length; i++) if (ts[i] - ts[i - 2] <= 10000) { w(b).bursts++; break; }
  if (g.winner && g.t >= 0) {
    const s = w(g.winner); s.wins++; s.prize += BigInt(g.prize || 0);
    const tWin = Number(d[g.t].t);
    s.afterWin += d.slice(g.t + 1).filter((x) => x.b === g.winner && Number(x.t) - tWin <= 10000).length;
    const first = d.findIndex((x) => x.b === g.winner);
    if (first >= d.length * 0.6 && g.t - first <= 4) s.lateWins++;
  }
}
const ase = (x) => (Number(x / 10n ** 16n) / 100).toLocaleString('fr-FR');
const sus = [...W.entries()].map(([b, s]) => {
  const why = [];
  if (s.afterWin >= 2) why.push(`${s.afterWin} fouilles envoyées juste APRÈS avoir trouvé le trésor (paquets automatiques)`);
  if (s.bursts >= 2) why.push(`rafales de 3 fouilles ou plus en 10 s sur ${s.bursts} cartes`);
  if (s.wins >= 3 && s.wins / s.maps >= 0.5) why.push(`${s.wins} cartes gagnées sur ${s.maps} jouées`);
  if (s.lateWins >= 3) why.push(`${s.lateWins} victoires en arrivant en fin de carte avec très peu de fouilles`);
  return { b, s, why, score: s.afterWin * 2 + s.bursts + (s.wins >= 3 ? s.wins : 0) + s.lateWins };
}).filter((x) => x.why.length >= 2).sort((a, b) => b.score - a.score);

const head = `🤖 Contrôle anti-bot ASE Treasure (dernières ${HOURS} h)\n${maps} cartes terminées, ${digsTot} fouilles, ${W.size} wallets.`;
if (!sus.length) await send(`${head}\n✅ Aucun bot suspect.`);
else await send(`${head}\n⚠️ ${sus.length} wallet(s) suspect(s) :\n\n` + sus.slice(0, 10).map((x) =>
  `• ${toAse1(x.b)}\n  ${x.s.wins} victoire(s), ${ase(x.s.prize)} ASE gagnés, ${x.s.digs} fouilles\n  - ${x.why.join('\n  - ')}`).join('\n\n'));
