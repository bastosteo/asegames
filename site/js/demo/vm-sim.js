// Simulateur LOCAL de la machine virtuelle Asentum (pour les tests).
// Il imite les globales vues dans les contrats réellement déployés :
//   storage (clé/valeur), msg {sender, value, contractAddress},
//   chain {blockTimestamp, blockNumber}, emit, assert, transfer, E.
// Chaque appel est atomique : si le contrat lève une erreur, toutes ses
// écritures et tous ses envois d'ASE sont annulés (comme on-chain).
// NB : c'est une imitation ; la sonde sert justement à confirmer ces
// hypothèses sur la vraie chaîne.

// Limite de gas par transaction envoyée par la CLI (mesurée : 1 000 000).
export const GAS_LIMIT = 1_000_000;

export class Chain {
  constructor({ startTimestampMs = 1_790_000_000_000, blockTimeMs = 6000 } = {}) {
    this.balances = new Map(); // adresse -> BigInt (wei)
    this.blockNumber = 1n;
    this.timestampMs = BigInt(startTimestampMs);
    this.blockTimeMs = BigInt(blockTimeMs);
    this.contracts = new Map();
    this.events = [];
    this.nextAddr = 1;
  }
  fund(addr, wei) {
    addr = addr.toLowerCase();
    this.balances.set(addr, (this.balances.get(addr) || 0n) + BigInt(wei));
  }
  balanceOf(addr) { return this.balances.get(addr.toLowerCase()) || 0n; }
  mine(n = 1) {
    this.blockNumber += BigInt(n);
    this.timestampMs += this.blockTimeMs * BigInt(n);
  }
  // Avance l'horloge jusqu'à un instant donné (ms), en minant les blocs.
  mineUntil(tsMs) {
    while (this.timestampMs < BigInt(tsMs)) this.mine(1);
  }
  deploy(source, deployer) {
    const address = '0x' + (0xc0de0000 + this.nextAddr++).toString(16).padStart(40, '0');
    const c = new Contract(this, address, source);
    this.contracts.set(address, c);
    return c;
  }
}

class Contract {
  constructor(chain, address, source) {
    this.chain = chain;
    this.address = address;
    this.store = new Map();
    this.msg = { sender: null, value: 0n, contractAddress: address };
    this.chainCtx = {};
    this.pendingTransfers = null;
    this.pendingEvents = null;
    this.gasOps = 0;
    const self = this;
    const storage = {
      // On-chain, une clé absente renvoie undefined (vérifié par la sonde).
      get: (k) => { self.gas.reads++; return self.store.has(String(k)) ? self.store.get(String(k)) : undefined; },
      set: (k, v) => {
        if (!self.readOnly) { if (self.store.has(String(k)) || self.touched.has(String(k))) self.gas.over++; else self.gas.fresh++; self.touched.add(String(k)); }
        if (self.readOnly) throw new Error('write not allowed in a read-only call (view)');
        // On-chain les valeurs semblent stockées en texte : on force du texte
        // pour que les tests attrapent les oublis de conversion.
        if (typeof v !== 'string') throw new Error('storage.set: non-string value (' + typeof v + ') for ' + k);
        self.store.set(String(k), v);
      },
      has: (k) => self.store.has(String(k)),
      delete: (k) => {
        if (self.readOnly) throw new Error('write not allowed in a read-only call (view)');
        self.store.delete(String(k));
      },
    };
    const emit = (name, data) => {
      if (self.readOnly) return;
      self.gas.events++;
      self.pendingEvents.push({ name, data: JSON.parse(JSON.stringify(data)) });
    };
    const assert = (cond, m) => { if (!cond) throw new Error(m || 'assertion failed'); };
    const transfer = (to, amount) => {
      if (self.readOnly) throw new Error('transfer not allowed in a read-only call');
      const amt = BigInt(amount);
      if (amt < 0n) throw new Error('negative amount');
      self.gas.transfers++;
      self.pendingTransfers.push({ to: String(to).toLowerCase(), amount: amt });
      const pendingOut = self.pendingTransfers.reduce((s, t) => s + t.amount, 0n);
      if (pendingOut > self.chain.balanceOf(self.address)) throw new Error('insufficient contract balance');
      return true;
    };
    const E = () => { throw new Error('E() not simulated'); };
    // Le fichier se termine par un objet ({...}) : eval renvoie cet objet.
    const factory = new Function('storage', 'msg', 'chain', 'emit', 'assert', 'transfer', 'E', 'cron',
      '"use strict"; return eval(arguments[8]);');
    this.api = factory(storage, this.msg, this.chainCtx, emit, assert, transfer, E, undefined, source);
  }

  _ctx(sender, value) {
    this.msg.sender = sender ? sender.toLowerCase() : null;
    this.msg.value = BigInt(value || 0);
    this.chainCtx.blockTimestamp = this.chain.timestampMs;
    this.chainCtx.blockNumber = this.chain.blockNumber;
  }

  // Transaction : atomique, débite la valeur jointe du compte appelant.
  call(sender, method, args = [], value = 0n) {
    const fn = this.api[method];
    if (typeof fn !== 'function') throw new Error('unknown method: ' + method);
    value = BigInt(value);
    const s = sender.toLowerCase();
    if (this.chain.balanceOf(s) < value) throw new Error('insufficient caller balance');
    const snapshot = new Map(this.store);
    this.pendingTransfers = [];
    this.pendingEvents = [];
    this.readOnly = false;
    // la valeur jointe arrive sur le contrat avant l'exécution
    this.chain.balances.set(s, this.chain.balanceOf(s) - value);
    this.chain.fund(this.address, value);
    this._ctx(s, value);
    this.gas = { reads: 0, fresh: 0, over: 0, transfers: 0, events: 0 };
    this.touched = new Set();
    try {
      const ret = fn.apply(this.api, JSON.parse(JSON.stringify(args)));
      // Estimation du gas d'après les mesures de la sonde.
      const g = this.gas;
      const gas = 21000 + g.reads * 800 + g.fresh * 20000 + g.over * 2900 + g.transfers * 10000 + g.events * 1000;
      this.lastGas = gas;
      if (gas > GAS_LIMIT) throw new Error('gas limit exceeded (estimated ' + gas + ')');
      for (const t of this.pendingTransfers) {
        this.chain.balances.set(this.address, this.chain.balanceOf(this.address) - t.amount);
        this.chain.fund(t.to, t.amount);
      }
      const evs = this.pendingEvents;
      this.chain.events.push(...evs.map((e) => ({ ...e, block: this.chain.blockNumber })));
      return { success: true, returnValue: ret, events: evs, transfers: this.pendingTransfers, gas };
    } catch (e) {
      this.store = snapshot;
      // rembourse la valeur jointe
      this.chain.balances.set(this.address, this.chain.balanceOf(this.address) - value);
      this.chain.fund(s, value);
      return { success: false, error: e.message };
    } finally {
      this.pendingTransfers = null;
      this.pendingEvents = null;
    }
  }

  // Lecture gratuite : aucune écriture permise.
  view(method, args = [], sender = null) {
    const fn = this.api[method];
    if (typeof fn !== 'function') throw new Error('unknown method: ' + method);
    this.readOnly = true;
    this.gas = { reads: 0, fresh: 0, over: 0, transfers: 0, events: 0 };
    this.touched = new Set();
    this._ctx(sender, 0n);
    try { return fn.apply(this.api, JSON.parse(JSON.stringify(args))); }
    finally { this.readOnly = false; }
  }
}
