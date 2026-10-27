// Simulateur local du sandbox Asentum, calqué sur ce que la SONDE a mesuré :
// - le contrat est un SCRIPT (pas un module) qui se termine par ({ ... })
// - globales : msg {sender, value(BigInt), contractAddress}, chain {blockNumber,
//   blockTimestamp(ms), chainId}, storage {get,set,delete,has,keys}, emit, assert, transfer
// - storage.set convertit TOUT en texte (42 -> "42", objet -> "[object Object]")
// - une erreur annule tout : stockage, ASE reçus, ASE envoyés, events
// - Math.random() et Date.now() lèvent une erreur
// - en lecture (view), msg.sender = adresse zéro
import vm from 'node:vm';
import fs from 'node:fs';

export const ZERO = '0x' + '0'.repeat(40);
export const ASE = 10n ** 18n;

export class Chain {
  constructor(sourcePath) {
    this.balances = new Map();
    this.store = new Map();
    this.events = [];
    this.blockNumber = 448000n;
    this.timestamp = 1791630000000n;               // ms
    this.contract = '0x69af5584de65dc6ab152dec732dcfc7e267b4b16';
    this.failTransferTo = null;                    // pour simuler un transfert qui échoue

    const self = this;
    const storage = {
      get: (k) => (self.store.has(k) ? self.store.get(k) : undefined),
      set: (k, v) => { self.store.set(String(k), String(v)); },
      delete: (k) => self.store.delete(k),
      has: (k) => self.store.has(k),
      keys: () => Array.from(self.store.keys()),
    };
    const ctx = {
      storage,
      emit: (name, data) => self.events.push({ name, data: JSON.parse(JSON.stringify(data)) }),
      assert: (cond, m) => { if (!cond) throw new Error(m || 'assertion failed'); },
      transfer: (to, amount) => {
        if (typeof amount !== 'string') throw new Error('transfer: montant en texte attendu');
        const a = BigInt(amount);
        if (self.failTransferTo && to === self.failTransferTo) throw new Error('transfer refusé (simulation)');
        const cb = self.bal(self.contract);
        if (cb < a) throw new Error('transfer: solde du contrat insuffisant');
        self.balances.set(self.contract, cb - a);
        self.balances.set(to, self.bal(to) + a);
        return true;
      },
      msg: null,
      chain: null,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    // comme le sandbox SES : pas d'horloge ni de hasard
    vm.runInContext(`Math.random = () => { throw new TypeError('secure mode Math.random() throws'); };
      Date.now = () => { throw new TypeError('secure mode Date.now() throws'); };`, ctx);
    this.ctx = ctx;
    const src = fs.readFileSync(sourcePath, 'utf8');
    // compilé comme un SCRIPT : un "export" ferait échouer, comme sur la vraie chaîne
    this.api = new vm.Script(src, { filename: 'jackpot.js' }).runInContext(ctx);
    if (!this.api || typeof this.api !== 'object') throw new Error('le contrat n\'exporte pas d\'objet');
  }

  bal(a) { return this.balances.get(a) || 0n; }
  fund(a, amount) { this.balances.set(a, this.bal(a) + amount); }

  // avance le temps (et les blocs, ~8,7 s par bloc comme mesuré)
  wait(ms) { this.timestamp += BigInt(ms); this.blockNumber += BigInt(Math.max(1, Math.round(ms / 8700))); }
  mine(blocks) { this.blockNumber += BigInt(blocks); this.timestamp += BigInt(blocks) * 8700n; }

  _setEnv(sender, value) {
    this.ctx.msg = { sender, value, contractAddress: this.contract };
    this.ctx.chain = { blockNumber: this.blockNumber, blockTimestamp: this.timestamp, chainId: 1423n };
  }

  // transaction : tout ou rien
  call(sender, method, args = [], value = 0n) {
    const snap = { store: new Map(this.store), balances: new Map(this.balances), events: this.events.length };
    try {
      if (this.bal(sender) < value) throw new Error('solde insuffisant');
      this.balances.set(sender, this.bal(sender) - value);
      this.balances.set(this.contract, this.bal(this.contract) + value);
      this._setEnv(sender, value);
      const fn = this.api[method];
      if (typeof fn !== 'function') throw new Error('méthode inconnue : ' + method);
      const out = fn.apply(this.api, args);
      this.blockNumber += 1n;
      return out;
    } catch (e) {
      this.store = snap.store; this.balances = snap.balances; this.events.length = snap.events;
      // le stockage du contexte doit pointer vers la Map restaurée
      throw e;
    }
  }

  view(method, args = []) {
    const snap = new Map(this.store);
    try {
      this._setEnv(ZERO, 0n);
      return this.api[method].apply(this.api, args);
    } finally { this.store = snap; }
  }
}
