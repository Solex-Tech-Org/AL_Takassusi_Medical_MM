'use strict';
/** Pure Nuclear calculation functions (FSD section 5). No DB / SAP access. */
const r = (v, d = 3) => Number((Math.round((v + Number.EPSILON) * 10 ** d) / 10 ** d).toFixed(d));
const positive = (v, name) => { if (!(Number(v) > 0)) throw new Error(`${name} must be positive`); return Number(v); };

/** Liquid batch = M + YYYYMMDD of the case service date ('YYYY-MM-DD'). No fallback. */
function liquidBatchFromServiceDate(serviceDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate || '')) throw new Error('ServiceDate must be YYYY-MM-DD');
  return 'M' + serviceDate.replace(/-/g, '');
}

/** Calculated Vials = Actual mCi / Maximum mCi per Vial   (12 / 50 = 0.240) */
function calculateLiquidVials(actualMci, maxMciPerVial) {
  return r(positive(actualMci, 'ActualMci') / positive(maxMciPerVial, 'MaximumMciPerVial'));
}

/** Liquid daily waste = received activity - activity posted to cases (same service date). */
function calculateLiquidDailyWaste({ receivedVials, maxMciPerVial, postedMci }) {
  const receivedMci = r(receivedVials * maxMciPerVial);
  const wasteMci = r(receivedMci - postedMci);
  return { receivedMci, wasteMci, wasteVials: r(wasteMci / maxMciPerVial) };
}

/** Powder: actual = total mCi / capacity; opened = ceiling; waste = opened - actual. */
function calculatePowderDailyWaste(totalActualMci, maxMciPerVial) {
  const raw = positive(totalActualMci, 'TotalActualMci') / positive(maxMciPerVial, 'MaximumMciPerVial');
  const openedVials = Math.ceil(r(raw, 6));
  const wasteVials = r(openedVials - raw);
  return { actualVials: r(raw), openedVials, wasteVials, wasteMci: r(wasteVials * maxMciPerVial) };
}

/**
 * Allocate `total` across items by weight (Actual mCi share). Rounded to `scale`
 * decimals; rounding residual goes to the largest item so the sum reconciles exactly.
 * items: [{ key, weight }] -> [{ key, share, amount }]
 */
function allocateByShare(items, total, scale = 3) {
  const sum = items.reduce((s, i) => s + i.weight, 0);
  if (!(sum > 0)) throw new Error('Allocation weights must sum to a positive value');
  const out = items.map(i => ({ key: i.key, share: r(i.weight / sum, 6), amount: r(total * i.weight / sum, scale), w: i.weight }));
  const residual = r(total - out.reduce((s, o) => s + o.amount, 0), scale);
  if (residual !== 0) {
    const big = out.reduce((a, b) => (b.w > a.w ? b : a));
    big.amount = r(big.amount + residual, scale);
  }
  return out.map(({ key, share, amount }) => ({ key, share, amount }));
}

/**
 * Powder FEFO: batches = [{ Batch, UnrestrictedQty, ShelfLifeExpirationDate }].
 * Earliest SLED first; continue to the next eligible batch when short.
 */
function fefoSelect(batches, requiredVials) {
  const eligible = batches.filter(b => Number(b.UnrestrictedQty) > 0)
    .sort((a, b) => String(a.ShelfLifeExpirationDate || '9999-12-31').localeCompare(String(b.ShelfLifeExpirationDate || '9999-12-31')));
  let remaining = r(requiredVials);
  const allocations = [];
  for (const b of eligible) {
    if (remaining <= 0) break;
    const take = r(Math.min(remaining, Number(b.UnrestrictedQty)));
    allocations.push({ batch: b.Batch, shelfLifeExpirationDate: b.ShelfLifeExpirationDate, vials: take });
    remaining = r(remaining - take);
  }
  return { allocations, shortfall: Math.max(remaining, 0) };
}

module.exports = { r, liquidBatchFromServiceDate, calculateLiquidVials, calculateLiquidDailyWaste,
  calculatePowderDailyWaste, allocateByShare, fefoSelect };
