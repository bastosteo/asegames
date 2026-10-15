import * as L from './lotomath.js';
import * as ref from '../../contrat/ref.mjs';
import { randomBytes } from 'node:crypto';
let ok = 0, ko = 0; const t = (n, c) => { c ? ok++ : (ko++, console.log('✗', n)); };
t('ase1→0x réel', L.toHex('ase1hypqm76acwd7lwvfsh396psdd5fm8zf35pjupv') === '0xb9020dfb5dc39befb98985e25d060d6d13b38931');
t('0x→ase1 réel', L.toAse1('0xb9020dfb5dc39befb98985e25d060d6d13b38931') === 'ase1hypqm76acwd7lwvfsh396psdd5fm8zf35pjupv');
t('0x→ase1 sonde', L.toAse1('0x2cf70f9d91dee27b1363ddc5c3994aec8f7f1adf') === 'ase19nmsl8v3mm38kymrmhzu8x22aj8h7xkl57vjj8');
let same = true;
for (let i = 0; i < 300; i++) { const a = randomBytes(32).toString('hex'), b = randomBytes(32).toString('hex'), d = randomBytes(32).toString('hex');
  if (JSON.stringify(L.drawNumbers(i, a, b, d, ref.MAXN)) !== JSON.stringify(ref.drawNumbers(i, a, b, d))) same = false;
  const g = [[1, 2, 3, 4, 5]]; if (L.nextDigest(d, '0xab', g, 'ff', i) !== ref.nextDigest(d, '0xab', g, 'ff', i)) same = false; }
t('tirage + empreinte identiques à la référence (300 cas)', same);
t('flash: 5 distincts', (() => { for (let i = 0; i < 500; i++) { const g = L.flashGrid(); if (new Set(g).size !== 5 || g.some((n) => n < 1 || n > 20)) return false; } return true; })());
t('fmtAse', L.fmtAse(1234567890000000000000n) === '1,234.57' && L.fmtAse(2n * L.WEI, 0) === '2');
t('parseAse', L.parseAse('2') === 2n * L.WEI && L.parseAse('5') === 5n * L.WEI && L.parseAse('2.5') === 5n * L.WEI / 2n && L.parseAse('0,5') === L.WEI / 2n && L.parseAse('1,000.5') === 10005n * L.WEI / 10n && L.parseAse('1,000') === 1000n * L.WEI);
t('parseAse invalide', (() => { try { L.parseAse('abc'); return false; } catch { return true; } })());

// Le site recalcule les gains comme le contrat (référence indépendante contrat/ref.mjs)
const R = await import('../../contrat/ref.mjs');
t('gains du site = référence (1000 cas)', (() => {
  for (let i = 0; i < 1000; i++) {
    const S = BigInt(Math.floor(Math.random() * 5000) + 1) * 5n * 10n ** 18n, J = BigInt(Math.floor(Math.random() * 1e6)) * 10n ** 16n;
    const c = [Math.floor(Math.random() * 40), Math.floor(Math.random() * 5), Math.floor(Math.random() * 2)];
    const a = L.payouts(S, 5n * 10n ** 18n, J, c), b = R.payouts(S, 5n * 10n ** 18n, J, c);
    if (a.per.join() !== b.per.join() || a.commission !== b.commission) return false;
  }
  return true;
})());
t('numéros du site = référence', (() => { for (let i = 0; i < 200; i++) { const h = R.sha(String(i)); if (L.drawNumbers(i, h, h, h, R.MAXN).join() !== R.drawNumbers(i, h, h, h).join()) return false; } return true; })());
console.log(ok, 'ok,', ko, 'ko'); process.exit(ko ? 1 : 0);
