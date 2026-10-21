// Accès à la chaîne : lectures (RPC public) et signature (wallet).
// Trois façons de signer :
//   - l'extension « Asentum Wallet » (window.asentum)
//   - le wallet Telegram (appairage par code à 6 chiffres, comme @asentum/connect)
//   - le mode démo (fausse chaîne dans le navigateur)
import { toHex } from './lotomath.js';

export class Rpc {
  constructor(urls) { this.urls = urls; this.i = 0; }
  get url() { return this.urls[this.i]; }
  async req(path, init) {
    let last;
    // Le testnet renvoie parfois une page d'erreur (HTML) : on essaie chaque serveur, 3 tours, avec une petite pause.
    for (let tour = 0; tour < 3; tour++) {
      if (tour) await new Promise((ok) => setTimeout(ok, 1500 * tour));
      for (let k = 0; k < this.urls.length; k++) {
        const u = this.urls[(this.i + k) % this.urls.length];
        try {
          const r = await fetch(u + path, { ...init, signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = JSON.parse(await r.text());
          this.i = (this.i + k) % this.urls.length;
          return j;
        } catch (e) { last = e; }
      }
    }
    throw new Error('The Asentum network is not responding (' + (last?.message || '?') + ')');
  }
  async view(contract, method, args = []) {
    const j = await this.req('/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract: toHex(contract), method, args }) });
    if (!j.ok) throw new Error(j.reason || 'read rejected');
    return j.returnValue;
  }
  async balance(addr) { return BigInt((await this.req('/balance/' + toHex(addr))).balance || 0); }
  async receipt(hash) {
    try { const j = await this.req('/receipts/' + hash); return j && j.blockNumber ? j : null; } catch { return null; }
  }
  async waitReceipt(hash, timeoutMs = 180000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await this.receipt(hash);
      if (r) return r;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    throw new Error('Transaction sent but not confirmed yet. It should show up within a few minutes.');
  }
}

// --- Extension navigateur --------------------------------------------
export class ExtensionWallet {
  constructor() { this.kind = 'extension'; this.address = null; }
  static available() { return typeof window !== 'undefined' && !!window.asentum; }
  async connect() { const r = await window.asentum.connect(); this.address = toHex(r.address); return this.address; }
  async restore() { try { const a = await window.asentum.getAddress(); if (a) { this.address = toHex(a); return this.address; } } catch {} return null; }
  async call(contract, method, args, valueWei = 0n) {
    const r = await window.asentum.callContract({ to: toHex(contract), method, args, value: String(valueWei) });
    return r.txHash;
  }
  async disconnect() { try { await window.asentum.disconnect(); } catch {} }
}

// --- Wallet Telegram (même protocole que @asentum/connect) ------------
export class TelegramWallet {
  constructor(botApi, dappName) { this.kind = 'telegram'; this.api = botApi; this.dappName = dappName; this.address = null; this.session = null; }
  async pair(onCode, shouldStop) {
    const r = await fetch(this.api + '/api/sessions/create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dappOrigin: location.origin, dappName: this.dappName }),
    });
    if (!r.ok) throw new Error('Telegram wallet unreachable (HTTP ' + r.status + ')');
    const { sessionId, code } = await r.json();
    onCode(code);
    for (let i = 0; i < 150; i++) {
      if (shouldStop()) throw new Error('Connection cancelled');
      await new Promise((ok) => setTimeout(ok, 2000));
      const s = await fetch(this.api + '/api/sessions/' + sessionId).then((x) => x.json()).catch(() => ({}));
      if (s.status === 'connected' && s.address) {
        this.session = sessionId; this.address = toHex(s.address);
        return this.address;
      }
    }
    throw new Error('Code expired: please start the connection again.');
  }
  async restore(sessionId) {
    try {
      const s = await fetch(this.api + '/api/sessions/' + sessionId).then((x) => x.json());
      if (s.status === 'connected' && s.address) { this.session = sessionId; this.address = toHex(s.address); return this.address; }
    } catch {}
    return null;
  }
  async call(contract, method, args, valueWei = 0n) {
    const cr = await fetch(`${this.api}/api/sessions/${this.session}/sign-request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'contract_call', to: toHex(contract), method, args, value: String(valueWei) }),
    });
    if (!cr.ok) throw new Error('Signature request rejected (session expired? please reconnect)');
    const { requestId } = await cr.json();
    for (let i = 0; i < 160; i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      const s = await fetch(`${this.api}/api/sessions/${this.session}/sign-requests/${requestId}`).then((x) => x.json()).catch(() => ({}));
      if (s.status === 'approved') return s.txHash;
      if (s.status === 'rejected') throw new Error(s.error || 'Rejected in the Telegram wallet');
      if (s.status === 'expired') throw new Error('Request expired (5 min): approve faster in Telegram.');
    }
    throw new Error('No response from the Telegram wallet');
  }
  async disconnect() {}
}
