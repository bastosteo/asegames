// =====================================================================
//  ASE Vegas — menu des commissions (LECTURE SEULE, aucune transaction)
//  Lancé par "Menu-commissions.bat".  node outils/menu-commissions.mjs
//  Chaque achat (grille, ticket, fouille) envoie tout de suite 15 % de commission :
//  moitié au contrat Airdrop, le reste partagé 75 % toi / 25 % collaborateur.
//  Le programme relit chaque achat sur la chaîne (avec son heure) et refait
//  exactement le même calcul que les contrats → totaux par jour, par tirage, par jeu.
// =====================================================================
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

const RPCS = [process.env.RPC_URL || 'https://testnet.asentum.com', 'https://explorer.asentum.com/rpc'].map((u) => u.replace(/\/$/, ''));
const CACHE = '.cache-commissions.json';
const BPS = 10000n, SHARE = 1500n, OWNER_CUT = 7500n, WEI = 10n ** 18n;
const TZ = 'Europe/Paris';

// ------------------------------------------------------------- chaîne
async function view(contract, method, args = []) {
  let last;
  for (let k = 0; k < 3; k++) for (const u of RPCS) {
    try {
      const r = await fetch(u + '/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract, method, args }), signal: AbortSignal.timeout(20000) });
      const t = await r.text();
      if (!t.trim().startsWith('{')) { last = new Error('réponse inattendue du nœud'); continue; }
      const j = JSON.parse(t);
      if (!j.ok) throw new Error(method + ' : ' + (j.reason || 'échec'));
      return j.returnValue;
    } catch (e) { last = e; if (/method not found|unknown/.test(String(e.message))) throw e; }
  }
  throw last;
}

// ------------------------------------------------------------- calculs
function split(cost, bps = 750) {   // exactement comme les contrats, achat par achat (bps : part Airdrop, 750 = 7,5 %, 600 = 6 %)
  const com = (cost * SHARE) / BPS, drop = bps === 750 ? com / 2n : (com * BigInt(bps)) / SHARE, owner = ((com - drop) * OWNER_CUT) / BPS;
  return { owner, collab: com - drop - owner, drop, sales: cost };
}
const zero = () => ({ owner: 0n, collab: 0n, drop: 0n, sales: 0n, n: 0 });
function add(a, s, n = 1) { a.owner += s.owner; a.collab += s.collab; a.drop += s.drop; a.sales += s.sales; a.n += n; }
function ase(w, d = 2) {
  const neg = w < 0n; if (neg) w = -w;
  const s = w.toString().padStart(19, '0'), i = s.slice(0, -18), f = s.slice(-18, -18 + d);
  return (neg ? '-' : '') + Number(i).toLocaleString('fr-FR') + (d ? ',' + f : '');
}
const day = (ms) => new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Number(ms)));
const dayLabel = (d) => { const [y, m, j] = d.split('-').map(Number); return new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' }).format(new Date(Date.UTC(y, m - 1, j))); };
const when = (ms) => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(Number(ms)));

// ------------------------------------------------------------- jeux
const GAMES = [
  { key: 'loto', name: 'Loto', marker: '.loto-v4-fait', unit: 'grilles', round: 'getRound', list: 'getPurchases', count: (r) => r.buys, done: (r) => r.status === 'done', qty: (p) => p.g.length, price: (r) => r.price, ts: (r) => r.drawTs },
  { key: 'raffle', name: 'Raffle', marker: '.tombola-v3-fait', unit: 'tickets', round: 'getRound', list: 'getPurchases', count: (r) => r.buys, done: (r) => r.status === 'done', qty: (p) => p.n, price: (r) => r.price, ts: (r) => r.drawTs },
  { key: 'treasure', name: 'Treasure', marker: '.tresor-v2-fait', unit: 'fouilles', round: 'getGrid', list: 'getDigs', count: (r) => r.digs, done: (r) => r.status === 'found' || r.status === 'cancelled', qty: () => 1, price: (r) => r.price, ts: (r) => r.endTs || r.openTs },
];
let cache = {};
try { if (existsSync(CACHE)) cache = JSON.parse(readFileSync(CACHE, 'utf8')); } catch { cache = {}; }
const saveCache = () => { try { writeFileSync(CACHE, JSON.stringify(cache)); } catch {} };

// Lit tous les tours d'un jeu : [{ id, r, items: [[t, qty]] }]
async function loadGame(g) {
  if (!existsSync(g.marker)) return null;
  const contract = readFileSync(g.marker, 'utf8').trim();
  const st = await view(contract, 'getState');
  const bps = Number(((await view(contract, 'getConfig').catch(() => null)) || {}).dropBps || 750);
  const rounds = [];
  for (let id = 1; id <= Number(st.cur || 0); id++) {
    const r = await view(contract, g.round, [id]);
    if (!r) continue;
    const n = g.count(r), key = contract + ':' + id;
    let c = cache[key];
    if (!c || c.n !== n) {
      const items = (c && c.n < n) ? c.items.slice() : [];
      let step = 200;
      for (let k = items.length; k < n;) {
        let batch;
        try { batch = await view(contract, g.list, [id, k, Math.min(step, n - k)]); }
        catch (e) { if (step > 25) { step = Math.floor(step / 2); continue; } throw e; }
        for (const p of batch) items.push([Number(p.t || 0), g.qty(p)]);
        k += batch.length;
        process.stdout.write('.');
      }
      c = cache[key] = { n, items };
    }
    rounds.push({ id, r, items: c.items });
  }
  saveCache();
  return { g, contract, rounds, bps };
}
function roundTotal(game, rd) {
  const t = zero(), price = BigInt(game.g.price(rd.r));
  for (const [, q] of rd.items) add(t, split(price * BigInt(q), game.bps), q);
  return t;
}

// ------------------------------------------------------------- affichage
const pad = (s, n) => String(s).padStart(n);
function header(first) { console.log(`  ${first.padEnd(22)}${pad('Toi', 12)}${pad('Collab', 12)}${pad('Airdrop', 12)}${pad('Ventes', 13)}`); console.log('  ' + '-'.repeat(71)); }
function line(label, t, extra = '') { console.log(`  ${String(label).padEnd(22)}${pad(ase(t.owner), 12)}${pad(ase(t.collab), 12)}${pad(ase(t.drop), 12)}${pad(ase(t.sales), 13)}${extra}`); }
function title(s) { console.log('\n  ' + s); console.log('  ' + '='.repeat(s.length)); }

function showRound(game, rd, label) {
  if (!rd) { console.log(`\n  ${game.g.name} : aucun tour trouvé.`); return; }
  const t = roundTotal(game, rd), r = rd.r;
  title(`${game.g.name} ${label} : n°${rd.id}`);
  const ts = game.g.ts(r);
  if (ts) console.log(`  ${game.g.key === 'treasure' ? 'Date' : 'Tirage'} : ${when(ts)} (heure de Paris)`);
  console.log(`  ${t.n} ${game.g.unit} · ${ase(t.sales)} ASE de ventes\n`);
  console.log(`  Toi (75 % de la part équipe)       ${pad(ase(t.owner, 4), 14)} ASE`);
  console.log(`  Collaborateur (25 %)               ${pad(ase(t.collab, 4), 14)} ASE`);
  console.log(`  Contrat Airdrop (moitié)           ${pad(ase(t.drop, 4), 14)} ASE`);
  console.log(`  Commission totale (15 %)           ${pad(ase(t.owner + t.collab + t.drop, 4), 14)} ASE`);
  if (!game.g.done(r)) console.log('\n  (tour en cours : le total grossit à chaque nouvel achat)');
}
function lastDone(game) { return [...game.rounds].reverse().find((rd) => game.g.done(rd.r)); }
function current(game) { const rd = game.rounds.at(-1); return rd && !game.g.done(rd.r) ? rd : null; }

function byDay(games) {   // { jour: { jeu: total } }
  const out = {};
  for (const game of games) for (const rd of game.rounds) {
    const price = BigInt(game.g.price(rd.r));
    for (const [t, q] of rd.items) {
      if (!t) continue;
      const d = day(t); out[d] ??= {}; out[d][game.g.key] ??= zero();
      add(out[d][game.g.key], split(price * BigInt(q), game.bps), q);
    }
  }
  return out;
}
function showDays(games, days, label) {
  const data = byDay(games);
  title(label + ' (heure de Paris, de 0 h 00 à 23 h 59)');
  header('Jour');
  const tot = zero();
  for (const d of days) {
    const t = zero();
    for (const v of Object.values(data[d] || {})) add(t, v, v.n);
    add(tot, t, t.n);
    line(dayLabel(d), t);
    for (const game of games) { const v = data[d]?.[game.g.key]; if (v && v.n) line('    ' + game.g.name, v); }
  }
  console.log('  ' + '-'.repeat(71));
  line('TOTAL', tot);
}
function lastDays(n) {
  const out = [], now = Date.now();
  for (let k = n - 1; k >= 0; k--) { const d = day(now - k * 86400000); if (!out.includes(d)) out.push(d); }
  return out;
}
function showTotals(games) {
  title('Totaux depuis le début (contrats actuels)');
  header('Jeu');
  const tot = zero();
  for (const game of games) {
    const t = zero();
    for (const rd of game.rounds) { const x = roundTotal(game, rd); add(t, x, x.n); }
    add(tot, t, t.n);
    line(`${game.g.name} (${t.n} ${game.g.unit})`, t);
  }
  console.log('  ' + '-'.repeat(71));
  line('TOTAL', tot);
  console.log(`\n  Commission totale : ${ase(tot.owner + tot.collab + tot.drop)} ASE`);
}

// ------------------------------------------------------------- menu
async function loadAll() {
  process.stdout.write('\n  Lecture de la chaîne');
  const games = [];
  for (const g of GAMES) { try { const x = await loadGame(g); if (x) games.push(x); } catch (e) { console.log(`\n  ⚠️  ${g.name} illisible : ${e.message}`); } }
  console.log(' ok');
  return games;
}
// Lecture des réponses au clavier (file d'attente : marche aussi quand l'entrée est collée d'un coup)
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = [], waiters = []; let closed = false;
rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()('0'); });
const ask = (q) => { process.stdout.write(q); return lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve('0') : new Promise((r) => waiters.push(r)); };
let games = await loadAll();
const find = (k) => games.find((x) => x.g.key === k);
for (;;) {
  console.log(`
  ===========================================
   ASE Vegas : commissions (lecture seule)
  ===========================================
   1. Les 7 derniers jours, jour par jour
   2. Dernier tirage du Loto (terminé)
   3. Tirage du Loto en cours
   4. Dernière Raffle (terminée)
   5. Raffle en cours
   6. Totaux détaillés (Loto, Raffle, Treasure)
   7. Historique jour par jour depuis le début
   8. Relire la chaîne (mettre à jour)
   0. Quitter`);
  const c = (await ask('\n  Ton choix : ')).trim();
  if (c === '0' || c === '') break;
  try {
    if (c === '1') showDays(games, lastDays(7), 'Les 7 derniers jours');
    else if (c === '2') find('loto') ? showRound(find('loto'), lastDone(find('loto')), 'dernier tirage') : console.log('  Loto introuvable.');
    else if (c === '3') { const g = find('loto'); g && current(g) ? showRound(g, current(g), 'tirage en cours') : console.log('\n  Pas de tirage du Loto en cours.'); }
    else if (c === '4') find('raffle') ? showRound(find('raffle'), lastDone(find('raffle')), 'dernière tombola') : console.log('  Raffle introuvable.');
    else if (c === '5') { const g = find('raffle'); g && current(g) ? showRound(g, current(g), 'tombola en cours') : console.log('\n  Pas de tombola en cours.'); }
    else if (c === '6') showTotals(games);
    else if (c === '7') {
      const all = Object.keys(byDay(games)).sort();
      all.length ? showDays(games, all, 'Historique jour par jour') : console.log('  Aucun achat trouvé.');
    } else if (c === '8') games = await loadAll();
    else console.log('  Choix inconnu.');
  } catch (e) { console.log('  Erreur : ' + e.message); }
  await ask('\n  (Entrée pour revenir au menu) ');
}
rl.close();
