// =====================================================================
//  ASE Vegas — éléments communs à toutes les pages
//   - le bouton « My wins » : tous les gains (et remboursements) à réclamer,
//     sur tous les jeux, avec « Claim all » ;
//   - le bouton wallet (et sa fenêtre) sur les pages qui n'en ont pas
//     (accueil, Airdrop) ; les jeux gardent le leur.
//  Le wallet est le même partout (mémorisé par le navigateur : loto.wallet).
// =====================================================================
import LOTO from './loto/js/config.js';
import RAFFLE from './raffle/js/config.js';
import TREASURE from './treasure/js/config.js';
import { Rpc, ExtensionWallet, TelegramWallet } from './loto/js/chain.js';
import * as L from './loto/js/lotomath.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
  raw(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
};
const rpc = new Rpc(LOTO.RPC);
const ase = (w) => L.fmtAse(BigInt(w), BigInt(w) % L.WEI === 0n ? 0 : 2);
const V = { wallet: null, saved: null, wins: [], busy: false, ownWalletBtn: false };

function toast(text, kind = '', ms = 6000) {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'toasts'; document.body.append(box); }
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = text;
  box.append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}
const cleanError = (e) => { const m = String(e && e.message ? e.message : e); const i = m.lastIndexOf('failed: '); return i >= 0 ? m.slice(i + 8) : m; };

// ------------------------------------------------------------- wallet (mémorisé)
async function restore() {
  const saved = store.raw('loto.wallet');
  if (saved === V.saved) return;
  V.saved = saved;
  V.wallet = null;
  const s = store.get('loto.wallet', null);
  try {
    if (s && s.kind === 'extension') {
      for (let i = 0; i < 10 && !ExtensionWallet.available(); i++) await new Promise((r) => setTimeout(r, 200));
      if (ExtensionWallet.available()) { const w = new ExtensionWallet(); if (await w.restore()) V.wallet = w; }
    } else if (s && s.kind === 'telegram') { const w = new TelegramWallet(LOTO.TELEGRAM_API, 'ASE Vegas'); if (await w.restore(s.session)) V.wallet = w; }
  } catch {}
  renderWalletBtn();
  await loadWins();
}

// ------------------------------------------------------------- gains à réclamer
async function loadWins() {
  const me = V.wallet && V.wallet.address;
  const wins = [];
  if (me) {
    const view = (c, m, a) => rpc.view(c, m, a);
    // ASE Loto : gains (settle) et remboursements des tirages annulés, 14 derniers tirages
    for (const LC of [LOTO.CONTRACT, LOTO.OLD].filter(Boolean)) {
      const old = LC !== LOTO.CONTRACT ? ' (previous Loto)' : '';
      try {
        const st = await view(LC, 'getState', []);
        for (let id = st.cur; id >= Math.max(1, st.cur - 14); id--) {
          const r = await view(LC, 'getRound', [id]);
          if (!r || !r.buys || (r.status !== 'done' && r.status !== 'cancelled')) continue;
          if (r.status === 'done' && Date.now() < Number(r.drawTs)) continue;   // dévoilé à l'heure du tirage
          for (let k = 0; k < r.buys; k += 400) {
            for (const p of await view(LC, 'getPurchases', [id, k, Math.min(400, r.buys - k)])) {
              if (p.b !== me || p.paid) continue;
              if (r.status === 'done' && p.prize !== '0') wins.push({ game: 'Loto', label: `Draw #${id}${old}`, amount: p.prize, c: LC, m: 'settle', a: [id, p.idx, 1] });
              if (r.status === 'cancelled') wins.push({ game: 'Loto', label: `Refund, draw #${id}${old}`, amount: (BigInt(r.price) * BigInt(p.g.length)).toString(), c: LC, m: 'settle', a: [id, p.idx, 1] });
            }
          }
        }
      } catch (e) { console.warn('loto', e); }
    }
    // ASE Raffle : prix (claim) et remboursements, 8 dernières semaines
    for (const RC of [RAFFLE.CONTRACT, RAFFLE.OLD].filter(Boolean)) {
      const old = RC !== RAFFLE.CONTRACT ? ' (previous raffle)' : '';
      try {
        const st = await view(RC, 'getState', []);
        for (let id = st.cur; id >= Math.max(1, st.cur - 8); id--) {
          const r = await view(RC, 'getRound', [id]);
          if (!r) continue;
          if (r.status === 'done' && Date.now() < Number(r.drawTs)) continue;   // dévoilé à l'heure du tirage
          if (r.status === 'done') r.win.forEach((w, k) => { if (w.b === me && !r.claimed[k]) wins.push({ game: 'Raffle', label: `Raffle #${id}, ${['1st', '2nd', '3rd'][k]} prize${old}`, amount: r.prizes[k], c: RC, m: 'claim', a: [id, k] }); });
          if (r.status === 'cancelled' && r.buys) for (const p of await view(RC, 'getPurchases', [id, 0, Math.min(400, r.buys)])) {
            if (p.b === me && !p.paid) wins.push({ game: 'Raffle', label: `Refund, raffle #${id}${old}`, amount: (BigInt(r.price) * BigInt(p.n)).toString(), c: RC, m: 'settle', a: [id, p.idx, 1] });
          }
        }
      } catch (e) { console.warn('raffle', e); }
    }
  }
  // ASE Treasure : trésor trouvé par ce wallet et pas encore envoyé → à réclamer (« Claim »)
  if (me && TREASURE.CONTRACT) {
    try {
      const view = (c, m, a) => rpc.view(c, m, a);
      const st = await view(TREASURE.CONTRACT, 'getState', []);
      const g = st.cur ? await view(TREASURE.CONTRACT, 'getGrid', [st.cur]) : null;
      if (g && g.status === 'open' && g.digs > 0) {
        const digs = [];
        for (let k = 0; k < g.digs; k += 400) digs.push(...(await view(TREASURE.CONTRACT, 'getDigs', [g.id, k, Math.min(400, g.digs - k)])));
        const mine = digs.filter((d) => d.b === me);
        if (mine.length) {
          const res = await fetch(`/api/treasure?grid=${g.id}&cells=${mine.map((d) => d.c).join(',')}`, { cache: 'no-store' }).then((r) => r.json());
          const t = (res.answers || []).find((x) => x.ans === 'T');
          if (t) {
            const k = digs.findIndex((d) => d.c === t.cell), price = BigInt(g.price);
            const amount = BigInt(g.carryIn || '0') + (price - (price * 1500n) / 10000n) * BigInt(k + 1);
            wins.push({ game: 'Treasure', label: `Map #${g.id}, treasure found`, amount: amount.toString(), c: TREASURE.CONTRACT, m: 'claim', a: [g.id, t.cell, t.salt, t.proof] });
          }
        }
      }
    } catch (e) { console.warn('treasure', e); }
  }
  V.wins = wins;
  renderWinsBtn();
  document.dispatchEvent(new CustomEvent('asevegas:wins', { detail: { wins, total: total() } }));
}
const total = () => V.wins.reduce((a, w) => a + BigInt(w.amount), 0n);

// ------------------------------------------------------------- boutons de l'en-tête
function actions() {
  let box = $('.top .top-actions');
  if (!box) { box = document.createElement('div'); box.className = 'top-actions'; $('.top').append(box); }
  return box;
}
function renderWinsBtn() {
  let b = $('#myWinsBtn');
  if (!b) {
    b = document.createElement('button');
    b.id = 'myWinsBtn'; b.type = 'button'; b.className = 'btn btn-wins';
    b.onclick = openWins;
    actions().prepend(b);
  }
  const n = V.wins.length;
  b.hidden = !V.wallet;
  b.classList.toggle('has', n > 0);
  b.textContent = n ? `My wins · ${ase(total())} ASE` : 'My wins';
}
function renderWalletBtn() {
  if (!V.ownWalletBtn) return;
  const b = $('#walletBtn');
  b.textContent = V.wallet ? L.shortAddr(V.wallet.address) : 'Connect wallet';
}

// ------------------------------------------------------------- fenêtre « My wins »
function dialog(id, html) {
  let d = $('#' + id);
  if (!d) { d = document.createElement('dialog'); d.id = id; d.className = 'dlg dlg-wide'; document.body.append(d); }
  d.innerHTML = html;
  return d;
}
function openWins() {
  const list = V.wins;
  const d = dialog('dlgWins', `
    <h2>My wins</h2>
    ${list.length ? `<p class="muted">Prizes waiting for you on ASE Vegas. They never expire.</p>
      <ol class="wins-list">${list.map((w, i) => `<li><span class="tag win">${esc(w.game)}</span><span>${esc(w.label)}</span><strong>${ase(w.amount)} ASE</strong><button class="btn btn-small" data-win="${i}">Claim</button></li>`).join('')}</ol>
      <div class="wins-total"><span>Total</span><strong>${ase(total())} ASE</strong></div>
      <button class="btn btn-primary btn-wide" id="claimAllWins">${list.length > 1 ? `Claim all (${list.length} transactions)` : 'Claim'}</button>`
    : '<p class="muted">Nothing to claim right now. Airdrop prizes are sent to your wallet automatically.</p>'}
    <form method="dialog"><button class="btn btn-ghost btn-wide" style="margin-top:10px">Close</button></form>`);
  d.querySelectorAll('[data-win]').forEach((b) => (b.onclick = () => claim([V.wins[Number(b.dataset.win)]])));
  const all = $('#claimAllWins', d); if (all) all.onclick = () => claim(V.wins.slice());
  d.showModal();
}
async function claim(items) {
  if (V.busy || !V.wallet) return;
  V.busy = true;
  let ok = 0;
  for (const [k, w] of items.entries()) {
    const t = toast(`${items.length > 1 ? `${k + 1}/${items.length} · ` : ''}Approve “${w.label}” in your wallet…`, '', 0);
    try {
      const hash = await V.wallet.call(w.c, w.m, w.a, 0n);
      t.textContent = 'Sent, waiting for confirmation…';
      const rc = await rpc.waitReceipt(hash);
      t.remove();
      if (!rc.success) throw new Error(rc.error || 'rejected by the contract');
      ok++;
    } catch (e) { t.remove(); toast('Failed: ' + cleanError(e), 'err', 10000); break; }
  }
  V.busy = false;
  if (ok) toast(`${ok > 1 ? ok + ' prizes' : 'Prize'} sent to your wallet ✓`, 'ok');
  $('#dlgWins') && $('#dlgWins').close();
  await loadWins();
}

// ------------------------------------------------------------- wallet (accueil, Airdrop)
function ownWallet() {
  V.ownWalletBtn = true;
  const b = document.createElement('button');
  b.id = 'walletBtn'; b.type = 'button'; b.className = 'btn btn-wallet'; b.textContent = 'Connect wallet';
  actions().append(b);
  b.onclick = () => {
    if (V.wallet) {
      const d = dialog('dlgW', `<h2>Your wallet</h2><p class="wdlg-addr">${esc(L.toAse1(V.wallet.address))}</p><button class="btn btn-danger btn-wide" id="wOut">Disconnect this wallet</button><form method="dialog"><button class="btn btn-ghost btn-wide" style="margin-top:10px">Close</button></form>`);
      $('#wOut', d).onclick = () => { store.del('loto.wallet'); d.close(); restore(); };
      return d.showModal();
    }
    let pairing = true;
    const d = dialog('dlgW', `<h2>Connect to Asentum</h2>
      <button class="choice" id="wExt" type="button" ${ExtensionWallet.available() ? '' : 'disabled'}><span class="c-text"><strong>Browser extension</strong><span>${ExtensionWallet.available() ? 'Use the wallet you already have installed.' : 'Not detected in this browser: install the Asentum Wallet extension, or use Telegram.'}</span></span><span class="c-cta">Connect</span></button>
      <button class="choice" id="wTg" type="button"><span class="c-text"><strong>Telegram wallet</strong><span>Pair with a 6-digit code, no app needed.</span></span><span class="c-cta">Pair</span></button>
      <div id="wPair" hidden><p class="wdlg-text">Open <strong>@AsentumBot</strong> in Telegram → tap <strong>Connect wallet</strong> → enter this code:</p><div class="code-boxes" id="wCode"></div><a class="tg-open" href="https://t.me/AsentumBot" target="_blank" rel="noopener">Open @AsentumBot ↗</a></div>
      <p class="error" id="wErr" hidden></p>
      <form method="dialog"><button class="btn btn-ghost btn-wide" style="margin-top:10px">Close</button></form>`);
    d.addEventListener('close', () => { pairing = false; }, { once: true });
    const err = (e) => { const p = $('#wErr', d); p.hidden = false; p.textContent = cleanError(e); };
    $('#wExt', d).onclick = async () => { try { const w = new ExtensionWallet(); await w.connect(); store.set('loto.wallet', { kind: 'extension' }); d.close(); restore(); } catch (e) { err(e); } };
    $('#wTg', d).onclick = async () => {
      $('#wPair', d).hidden = false;
      try {
        const w = new TelegramWallet(LOTO.TELEGRAM_API, 'ASE Vegas');
        await w.pair((code) => ($('#wCode', d).innerHTML = String(code).split('').map((c) => `<span>${esc(c)}</span>`).join('')), () => !pairing);
        store.set('loto.wallet', { kind: 'telegram', session: w.session }); d.close(); restore();
      } catch (e) { if (!/cancelled/i.test(String(e && e.message))) err(e); }
    };
    d.showModal();
  };
}

// ------------------------------------------------------------- démarrage
export function startVegas({ walletButton = false } = {}) {
  if (new URLSearchParams(location.search).has('demo')) return;   // pas en mode démo
  if (walletButton) ownWallet();
  renderWinsBtn();
  restore();
  // Le wallet a changé sur cette page ou un autre onglet : on relit
  setInterval(restore, 3000);
  setInterval(loadWins, 60000);
  document.addEventListener('asevegas:refresh-wins', loadWins);
}
export const myWins = () => ({ wins: V.wins, total: total(), wallet: V.wallet });
