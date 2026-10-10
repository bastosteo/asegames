// ASE Game — page d'accueil : thème + infos en direct du loto (lues sur la chaîne).
import CONFIG from './loto/js/config.js';
import { Rpc } from './loto/js/chain.js';
import { fmtAse } from './loto/js/lotomath.js';

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; };
applyTheme(store.get('asegame.theme', null));
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next); store.set('asegame.theme', next);
};

let info = null, offset = 0;
async function load() {
  if (!CONFIG.CONTRACT) { $('#lotoJackpot').textContent = 'démo'; $('#lotoCountdown').textContent = '–'; return; }
  try {
    info = await new Rpc(CONFIG.RPC).view(CONFIG.CONTRACT, 'info', []);
    offset = Number(info.now) - Date.now();
    $('#lotoJackpot').textContent = fmtAse(info.jackpotEstimate, 0) + ' ASE';
    tick();
  } catch { $('#lotoJackpot').textContent = '–'; }
}
function tick() {
  if (!info) return;
  const s = Math.floor((Number(info.closeTs) - (Date.now() + offset)) / 1000);
  if (s <= 0) { $('#lotoCountLabel').textContent = 'Tirage'; $('#lotoCountdown').textContent = 'en cours'; return; }
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  $('#lotoCountLabel').textContent = 'Fin des ventes dans';
  $('#lotoCountdown').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}
load();
setInterval(tick, 1000);
setInterval(load, 30000);
