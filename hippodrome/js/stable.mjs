// =====================================================================
//  Hippodrome ASE Vegas — l'écurie et les calculs de course
//  Partagé par le site (affichage) et les croupiers (choix des partants).
//  Le contrat ne connaît les chevaux que par leur numéro (0 à 17) : tout ce
//  qui est ici peut changer sans redéployer le contrat.
// =====================================================================

// [nom, écurie, couleur de casaque, motif]
export const HORSES = [
  ['Loto', 'ASEVegas', '#4dd8ff', 'losanges'], ['Treasure', 'ASEVegas', '#7dffb0', 'rayures'], ['Raffle', 'ASEVegas', '#ff9f5a', 'étoile'],
  ['Milkie 1', 'Milkie', '#ffc94d', 'éclair'], ['Milkie 2', 'Milkie', '#ff5d73', 'chevrons'], ['Milkie 3', 'Milkie', '#8f8fff', 'damier'],
  ['Betman', 'ASEBet', '#c77dff', 'cercles'], ['Mine$Bet', 'ASEBet', '#ff7ac8', 'flèche'], ['#1', 'ASEBet', '#4dffd2', 'bandes'],
  ['WebDown', 'ASEDex', '#f2f2f2', 'croix'], ['Slippage', 'ASEDex', '#ff4d4d', 'pois'], ['Liquidity', 'ASEDex', '#7a9cff', 'triangles'],
  ['Faucet', 'Asentum', '#b8ff4d', 'spirale'], ['Auras', 'Asentum', '#4da6ff', 'vagues'], ['ASE', 'Asentum', '#ffd24d', 'demi-lune'],
  ['Bonding Curve', 'ASEPad', '#ff8f4d', 'étoiles'], ['Fair Launch', 'ASEPad', '#9dff8f', 'feuilles'], ['Moonshot', 'ASEPad', '#d0b3ff', 'atomes'],
];
export const JOCKEYS = ['L. Moreau', 'K. Tanaka', 'S. Diallo', 'M. Rossi', 'A. Novak', 'J. Silva', 'E. Laurent', 'R. Okafor', 'N. Ivanova',
  'T. Dubois', 'C. Mendes', 'Y. Kim', 'B. Haddad', 'O. Petit', 'P. Garnier', 'H. Sato', 'D. Costa', 'F. Martin'];
export const TERRAINS = ['Firm', 'Soft', 'Heavy', 'Sand'];
export const TERRAIN_ICONS = ['☀️', '🌱', '🌧️', '🏜️'];
export const prefOf = (id) => id % 4;                 // terrain préféré de chaque cheval
export const INJURY_RACES = 15;                        // une chute = 3 jours de repos (5 courses par jour)

// Statistiques d'un cheval à partir des courses passées (les plus récentes d'abord).
// races : [{ id, status, horses:[6 n°], order:[6 couloirs], fell }]
export function statsOf(id, races) {
  const places = [], done = races.filter((r) => r.status === 'done' && Array.isArray(r.order) && Array.isArray(r.horses));
  let since = null, injuredFor = 0;
  done.forEach((r, k) => {
    const lane = r.horses.indexOf(id);
    if (lane < 0) return;
    if (since === null) since = k;                                   // courses depuis sa dernière sortie
    if (r.fell === lane) { if (k < INJURY_RACES) injuredFor = Math.max(injuredFor, INJURY_RACES - k); places.push(6); }
    else if (places.length < 5) places.push(r.order.indexOf(lane) + 1);
  });
  const last = places.slice(0, 5);
  const avg = last.length ? last.reduce((a, b) => a + b, 0) / last.length : 3.5;
  const form = Math.max(0.5, Math.min(5, 6.2 - avg));
  const energy = since === null ? 5 : Math.min(5, 1 + since);
  return { last, form, energy, injuredFor, pref: prefOf(id) };
}
export const scoreOf = (s, terrain) => 1 + s.form * 0.9 + (s.pref === terrain ? 1.6 : 0) + s.energy * 0.25;
// Risque de chute en millionièmes : ≈ 1 course sur 50 en moyenne, surtout pour un cheval pas en forme et pas sur son terrain
export const fallPpm = (s, terrain) => Math.round(1500 * (s.form < 2.5 ? 2.4 : s.form < 3.5 ? 1.2 : 0.5) * (s.pref === terrain ? 0.6 : 1.8));

// Poids publiés dans le contrat (chances = poids ÷ total), avec la chance minimale du contrat (+ marge)
export function weightsOf(scores, minChanceBps = 500) {
  const w = scores.map((x) => Math.round(x * 1000));
  const target = minChanceBps + 50;
  for (let k = 0; k < 20; k++) {
    const W = w.reduce((a, b) => a + b, 0);
    let changed = false;
    for (let i = 0; i < w.length; i++) if (w[i] * 10000 < W * target) { w[i] = Math.ceil(W * target / 10000) + 1; changed = true; }
    if (!changed) break;
  }
  return w;
}

// Choix des partants et du terrain d'une course (croupier). rand() → nombre dans [0, 1[.
export function makeSetup(races, rand, minChanceBps = 500) {
  const terrain = Math.floor(rand() * 4);
  const pool = HORSES.map((_, id) => ({ id, s: statsOf(id, races) })).filter((h) => !h.s.injuredFor);
  const runners = [];
  while (runners.length < 6 && pool.length) {        // tirage pondéré : un cheval reposé sort plus souvent
    const tot = pool.reduce((a, h) => a + h.s.energy, 0);
    let x = rand() * tot, k = 0;
    while (k < pool.length - 1 && (x -= pool[k].s.energy) >= 0) k++;
    runners.push(pool.splice(k, 1)[0]);
  }
  if (runners.length < 6) throw new Error('moins de 6 chevaux disponibles');
  return {
    horses: runners.map((h) => h.id), terrain,
    w: weightsOf(runners.map((h) => scoreOf(h.s, terrain)), minChanceBps),
    f: runners.map((h) => fallPpm(h.s, terrain)),
    info: 'v1',
  };
}

// Heures des courses (heure de Paris)
export const RACE_HOURS = [18, 19, 20, 21, 22];
function parisOffsetMs(utcMs) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).reduce((o, x) => ((o[x.type] = x.value), o), {});
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
// Prochain départ (ms UTC) au moins minLeadMs après "fromMs"
export function nextSlot(fromMs, minLeadMs = 32 * 60000, hours = RACE_HOURS) {
  const min = fromMs + minLeadMs;
  const d0 = new Date(fromMs + parisOffsetMs(fromMs));
  for (let day = 0; day < 4; day++) {
    for (const h of hours) {
      const guess = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate() + day, h, 0, 0);
      const t = guess - parisOffsetMs(guess);
      if (t >= min) return t;
    }
  }
  throw new Error('aucun créneau');
}

// Durées de course rejouées par le site, identiques pour tous les spectateurs (tirées de la graine commune)
export function racePlan(rand, order, fell) {
  let x = parseInt(String(rand || '0').slice(0, 12), 16) || 1;
  const next = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const T = new Array(6).fill(0);
  let t = 20 + next() * 1.2;
  order.filter((l) => l !== fell).forEach((lane, k) => { T[lane] = t; t += k === 0 ? 0.06 + next() * 0.4 : 0.12 + next() * 0.6; });
  const shape = Array.from({ length: 6 }, () => ({ a: (next() - 0.5) * 0.7, b: (next() - 0.5) * 0.45, ph: next() < 0.5 ? 0 : Math.PI }));
  const fallAt = fell >= 0 ? 6 + next() * 6 : -1;
  if (fell >= 0) T[fell] = 21 + next();
  return { T, shape, fallAt };
}

// =====================================================================
//  v3 : chevaux des joueurs (contrat Écurie). Les chevaux de la maison ont
//  les n° 1 000 000 + k (k = rang dans HORSES ci-dessus).
// =====================================================================
export const HOUSE0 = 1000000;
export const CLASSES = ['Outsider', 'Hopeful', 'Standard', 'Challenger', 'Challenger+', 'Elite'];
export const isHouse = (id) => Number(id) >= HOUSE0;
const PALETTE = ['#4dd8ff', '#7dffb0', '#ff9f5a', '#ffc94d', '#ff5d73', '#8f8fff', '#c77dff', '#ff7ac8', '#4dffd2', '#f2f2f2', '#ff4d4d', '#7a9cff', '#b8ff4d', '#4da6ff', '#ffd24d', '#ff8f4d', '#9dff8f', '#d0b3ff'];
export const colorOf = (id) => isHouse(id) ? HORSES[Number(id) - HOUSE0][2] : PALETTE[(Number(id) * 7) % PALETTE.length];
export const prefOf3 = (id) => isHouse(id) ? prefOf(Number(id) - HOUSE0) : Number(id) % 4;

// État d'un cheval de joueur à un instant donné (ms). cfg = réglages du contrat Écurie.
export function horseState(h, cfg, nowMs, raceAtMs = nowMs) {
  const win = Number(cfg.feedWin), fd = (h.fd || []).map(Number), tr = (h.tr || []).map(Number);
  const lastFed = Math.max(Number(h.b), ...fd);
  return {
    hungry: nowMs - lastFed > win,
    bloated: fd.filter((t) => t > nowMs - win).length >= Number(cfg.bloatAt),
    trained: tr.length > 0,
    over: tr.filter((t) => t + win > raceAtMs).length >= Number(cfg.overTrain),
    injured: Number(h.inj) > nowMs, injUntil: Number(h.inj),
    fedIn: lastFed + win - nowMs,                    // ms avant d'avoir faim (négatif : a faim)
  };
}
// Poids (chance relative, ‰) d'un partant
export function weight3(h, cfg, terrain, nowMs, raceAtMs) {
  if (isHouse(h.id)) return Number(cfg.houseW) + (prefOf3(h.id) === terrain ? Number(cfg.terrB) : 0);
  const s = horseState(h, cfg, nowMs, raceAtMs);
  const w = Number(cfg.clsW[h.c]) + (s.trained ? Number(cfg.trainB) : 0) - (s.hungry ? Number(cfg.hunger) : 0)
    - (s.bloated ? Number(cfg.bloat) : 0) + (prefOf3(h.id) === terrain ? Number(cfg.terrB) : 0);
  return Math.max(60, w);
}
// Note sur 10 affichée (190 ‰ → 9,0 ; 150 → 5,0)
export const noteOf = (w) => Math.max(0, Math.min(10, (w - 100) / 10));
export function fall3(h, cfg, terrain, nowMs, raceAtMs) {
  let f = Number(cfg.fallPpm) * (prefOf3(h.id) === terrain ? 0.6 : 1.4);
  if (!isHouse(h.id) && horseState(h, cfg, nowMs, raceAtMs).over) f += Number(cfg.overFall);
  return Math.min(50000, Math.round(f));
}
// Partants de la course (croupier) : les inscrits + des chevaux de la maison, couloirs mélangés.
// entries : chevaux des joueurs (objets du contrat). rand() → [0, 1[
export function makeSetup3(entries, cfg, rand, nowMs, raceAtMs) {
  const terrain = Math.floor(rand() * 4);
  const runners = entries.map((h) => ({ ...h, id: String(h.id) }));
  const pool = HORSES.map((_, k) => k);
  while (runners.length < 6) runners.push({ id: String(HOUSE0 + pool.splice(Math.floor(rand() * pool.length), 1)[0]) });
  for (let i = 5; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [runners[i], runners[j]] = [runners[j], runners[i]]; }
  return {
    horses: runners.map((h) => Number(h.id)), terrain,
    w: runners.map((h) => weight3(h, cfg, terrain, nowMs, raceAtMs)),
    f: runners.map((h) => fall3(h, cfg, terrain, nowMs, raceAtMs)),
  };
}
export const RACE_HOUR = 19;
