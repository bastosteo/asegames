// ASE Vegas — page d'accueil : thème + infos en direct du loto (lues sur la chaîne).
import CONFIG from './loto/js/config.js';
import RAFFLE from './raffle/js/config.js';
import DROP from './airdrop/js/config.js';
import { Rpc } from './loto/js/chain.js';
import { fmtAse } from './loto/js/lotomath.js';

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; };
applyTheme('dark');   // ASE Vegas est uniquement en mode sombre, comme Asentum

const utcTime = (ms) => new Date(Number(ms)).toISOString().slice(11, 16) + ' UTC';
const utcWeekday = (ms) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(Number(ms)).getUTCDay()];
let info = null, offset = 0;
async function load() {
  if (!CONFIG.CONTRACT) { $('#lotoJackpot').textContent = 'demo'; $('#lotoCountdown').textContent = '–'; return; }
  try {
    info = await new Rpc(CONFIG.RPC).view(CONFIG.CONTRACT, 'info', []);
    offset = Number(info.now) - Date.now();
    $('#lotoJackpot').textContent = fmtAse(info.jackpotEstimate, 0) + ' ASE';
    $('#lotoTime').textContent = utcTime(info.drawTs);
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
    $('#raffleTime').textContent = `${utcWeekday(rinfo.drawTs)} at ${utcTime(rinfo.drawTs)}`;
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
async function weekFees(rpc, contract, from, to) {
  if (!contract) return 0n;
  const st = await rpc.view(contract, 'getState', []);
  let sum = 0n;
  for (let id = st.cur; id >= 1; id--) {
    const r = await rpc.view(contract, 'getRound', [id]);
    if (!r) continue;
    if (Number(r.drawTs) <= from) break;
    if (Number(r.drawTs) <= to && r.status === 'done') sum += BigInt(r.airdrop || '0');
  }
  return sum;
}
async function loadDrop() {
  if (!DROP.CONTRACT) { $('#dropPot').textContent = 'soon'; $('#dropCountdown').textContent = '–'; return; }
  try {
    const rpc = new Rpc(DROP.RPC);
    dinfo = await rpc.view(DROP.CONTRACT, 'info', []);
    doff = Number(dinfo.now) - Date.now();
    tickDrop();
    $('#dropTime').textContent = `${utcWeekday(dinfo.drawTs)} at ${utcTime(dinfo.drawTs)}`;
    const prev = dinfo.round > 1 ? await rpc.view(DROP.CONTRACT, 'getRound', [dinfo.round - 1]) : null;
    const from = prev && prev.status !== 'cancelled' ? Number(prev.drawTs) : Number(dinfo.fromTs);
    const to = Number(dinfo.drawTs);
    const [a, b] = await Promise.all([weekFees(rpc, CONFIG.CONTRACT, from, to), weekFees(rpc, RAFFLE.CONTRACT, from, to)]);
    $('#dropPot').textContent = fmtAse(a + b + BigInt(dinfo.carry), 2) + ' ASE';
  } catch { $('#dropPot').textContent = '–'; }
}
function tickDrop() {
  if (!dinfo) return;
  const s = Math.floor((Number(dinfo.drawTs) - (Date.now() + doff)) / 1000);
  if (s <= 0) { $('#dropCountdown').textContent = 'drawing'; return; }
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  $('#dropCountdown').textContent = d ? `${d}d ${h}h` : `${h}h ${String(m).padStart(2, '0')}m`;
}
loadDrop();
setInterval(tickDrop, 1000);
setInterval(loadDrop, 60000);
