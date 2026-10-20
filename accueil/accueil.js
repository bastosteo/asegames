// ASE Vegas — page d'accueil : thème + infos en direct du loto (lues sur la chaîne).
import CONFIG from './loto/js/config.js';
import RAFFLE from './raffle/js/config.js';
import DROP from './airdrop/js/config.js';
import TREASURE from './treasure/js/config.js';
import { Rpc } from './loto/js/chain.js';
import { fmtAse } from './loto/js/lotomath.js';
import { startVegas } from './vegas.js';
import { buildWeek } from './airdrop/js/liste.mjs';
startVegas({ walletButton: true });

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; };
applyTheme('dark');   // ASE Vegas est uniquement en mode sombre, comme Asentum

const utcTime = (ms) => new Date(Number(ms)).toISOString().slice(11, 16) + ' UTC';
const utcWeekday = (ms) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(Number(ms)).getUTCDay()];
// Prix d'une mise : « 1 ASE », « 0.2 ASE »
const fmtPrice = (w) => { const t = fmtAse(w, BigInt(w) % 10n ** 18n === 0n ? 0 : 2); return (t.includes('.') ? t.replace(/\.?0+$/, '') : t) + ' ASE'; };
let info = null, offset = 0;
async function load() {
  if (!CONFIG.CONTRACT) { $('#lotoJackpot').textContent = 'demo'; $('#lotoCountdown').textContent = '–'; return; }
  try {
    info = await new Rpc(CONFIG.RPC).view(CONFIG.CONTRACT, 'info', []);
    offset = Number(info.now) - Date.now();
    $('#lotoJackpot').textContent = fmtAse(info.jackpotEstimate, 0) + ' ASE';
    $('#lotoTime').textContent = utcTime(info.drawTs);
    if (info.price) $('#lotoPrice').textContent = fmtPrice(info.price);
    tick();
  } catch { $('#lotoJackpot').textContent = '–'; }
}
function tick() {
  if (!info) return;
  const s = Math.floor((Number(info.closeTs) - (Date.now() + offset)) / 1000);
  if (s <= 0) { $('#lotoCountLabel').textContent = 'Draw'; $('#lotoCountdown').textContent = 'in progress'; return; }
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  $('#lotoCountLabel').textContent = 'Sales close in';
  $('#lotoCountdown').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}
load();
setInterval(tick, 1000);
setInterval(load, 30000);

// ASE Raffle : cagnotte et compte à rebours
let rinfo = null, roff = 0;
async function loadRaffle() {
  if (!RAFFLE.CONTRACT) { $('#rafflePot').textContent = 'soon'; $('#raffleCountdown').textContent = '–'; return; }
  try {
    rinfo = await new Rpc(RAFFLE.RPC).view(RAFFLE.CONTRACT, 'info', []);
    roff = Number(rinfo.now) - Date.now();
    $('#rafflePot').textContent = fmtAse(rinfo.pot, 0) + ' ASE';
    if (rinfo.price) $('#rafflePrice').textContent = fmtPrice(rinfo.price);
    $('#raffleTime').textContent = `${utcWeekday(rinfo.drawTs)} at ${utcTime(rinfo.drawTs)}`;
    if (rinfo.drawDays !== undefined) {   // tombola v4 : plusieurs tirages par semaine, top 3 + lots
      const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].filter((_, k) => (rinfo.drawDays >> k) & 1);
      $('#raffleEvery').textContent = D.length > 1 ? D.join(' · ') : 'Every ' + utcWeekday(rinfo.drawTs);
      $('#raffleWinners').textContent = `Up to ${3 + Number(rinfo.maxLots || 0)} winners`;
    }
    tickRaffle();
  } catch { $('#rafflePot').textContent = '–'; }
}
function tickRaffle() {
  if (!rinfo) return;
  const s = Math.floor((Number(rinfo.drawTs) - (Date.now() + roff)) / 1000);
  if (s <= 0) { $('#raffleCountdown').textContent = 'drawing'; return; }
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  $('#raffleCountdown').textContent = d ? `${d}d ${h}h` : `${h}h ${String(m).padStart(2, '0')}m`;
}
loadRaffle();
setInterval(tickRaffle, 1000);
setInterval(loadRaffle, 60000);

// ASE Airdrop : frais de la semaine déjà reçus (+ report) et compte à rebours
let dinfo = null, doff = 0;
async function loadDrop() {
  if (!DROP.CONTRACT) { $('#dropPot').textContent = 'soon'; $('#dropCountdown').textContent = '–'; return; }
  try {
    const rpc = new Rpc(DROP.RPC);
    dinfo = await rpc.view(DROP.CONTRACT, 'info', []);
    doff = Number(dinfo.now) - Date.now();
    tickDrop();
    const res = Number(dinfo.drawTs) + (DROP.RESULT_DELAY_MIN || 0) * 60000;
    $('#dropTime').textContent = `${utcWeekday(res)} at ${utcTime(res)}`;
    const prev = dinfo.round > 1 ? await rpc.view(DROP.CONTRACT, 'getRound', [dinfo.round - 1]) : null;
    // Semaine des tickets : de la tombola du dimanche à la suivante (24 h avant chaque Airdrop du lundi)
    const f0 = prev && prev.status !== 'cancelled' ? Number(prev.drawTs) : Number(dinfo.fromTs);
    // Montant exact : 7,5 % de chaque achat de la semaine, déjà versés au contrat Airdrop.
    const both = (x, y) => [x, y].flatMap((v) => String(v || '').split(',')).map((v) => v.trim()).filter(Boolean);   // ancien(s) contrat(s) : liste séparée par des virgules
    const wk = await buildWeek({ view: (c, m, a) => rpc.view(c, m, a), loto: both(CONFIG.CONTRACT, DROP.OLD_LOTO), raffle: both(RAFFLE.CONTRACT, DROP.OLD_RAFFLE), treasure: both(TREASURE.CONTRACT, DROP.OLD_TREASURE), fromTs: f0, toTs: dinfo.drawTs, now: dinfo.now });
    $('#dropPot').textContent = fmtAse(BigInt(wk.pot) + BigInt(dinfo.carry), 2) + ' ASE';
  } catch { $('#dropPot').textContent = '–'; }
}
function tickDrop() {
  if (!dinfo) return;
  const s = Math.floor((Number(dinfo.drawTs) + (DROP.RESULT_DELAY_MIN || 0) * 60000 - (Date.now() + doff)) / 1000);
  if (s <= 0) { $('#dropCountdown').textContent = 'drawing'; return; }
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  $('#dropCountdown').textContent = d ? `${d}d ${h}h` : `${h}h ${String(m).padStart(2, '0')}m`;
}
loadDrop();
setInterval(tickDrop, 1000);
setInterval(loadDrop, 60000);

// ASE Treasure : trésor en cours
async function loadTreasure() {
  if (!TREASURE.CONTRACT) { $('#treasurePot').textContent = 'soon'; $('#treasureDigs').textContent = '–'; return; }
  try {
    const i = await new Rpc(TREASURE.RPC).view(TREASURE.CONTRACT, 'info', []);
    $('#treasurePot').textContent = fmtAse(i.pot, 2) + ' ASE';
    $('#treasureDigs').textContent = String(i.digs);
    const g = i.status === 'open' ? await new Rpc(TREASURE.RPC).view(TREASURE.CONTRACT, 'getGrid', [i.grid]).catch(() => null) : null;
    $('#treasurePrice').textContent = fmtPrice((g && g.price) || i.price);
  } catch { $('#treasurePot').textContent = '–'; }
}
loadTreasure();
setInterval(loadTreasure, 30000);

// Bandeau « prizes to claim » : rempli par le module commun (vegas.js)
document.addEventListener('asevegas:wins', (e) => {
  const { wins, total } = e.detail;
  $('#winsStrip').hidden = !wins.length;
  if (wins.length) $('#winsTotal').textContent = `${fmtAse(total, 2)} ASE · ${wins.length} ${wins.length > 1 ? 'prizes' : 'prize'}`;
});
$('#winsOpen').onclick = () => $('#myWinsBtn') && $('#myWinsBtn').click();
