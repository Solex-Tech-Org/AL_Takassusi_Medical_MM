'use strict';
/** Pure Nuclear calculation functions (FSD section 5). No DB / SAP access. */
const r = (v, d = 3) => Number((Math.round((v + Number.EPSILON) * 10 ** d) / 10 ** d).toFixed(d));
const positive = (v, name) => { if (!(Number(v) > 0)) throw new Error(`${name} must be positive`); return Number(v); };

/** Liquid batch prefix = YYMMDD-; no batch from another service date may be used. */
function liquidBatchPrefixFromServiceDate(serviceDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate || '')) throw new Error('ServiceDate must be YYYY-MM-DD');
  const [year, month, day] = serviceDate.split('-');
  return `${year.slice(-2)}${month}${day}-`;
}

/** Compatibility helper for the existing single-batch function endpoint. */
function liquidBatchFromServiceDate(serviceDate) { return `${liquidBatchPrefixFromServiceDate(serviceDate)}001`; }

/** Calculated Vials = Actual mCi / Maximum mCi per Vial   (12 / 50 = 0.240) */
function calculateLiquidVials(actualMci, maxMciPerVial) {
  return r(positive(actualMci, 'ActualMci') / positive(maxMciPerVial, 'MaximumMciPerVial'));
}

/** Liquid daily waste = received activity - activity posted to cases (same service date). */
function calculateLiquidDailyWaste({ receivedVials, maxMciPerVial, postedMci, receivedMci: received, caseMci }) {
  const receivedMci = received == null ? r(receivedVials * maxMciPerVial) : Number(received);
  const consumedMci = caseMci == null ? Number(postedMci || 0) : Number(caseMci);
  const wasteMci = r(receivedMci - consumedMci);
  return { receivedMci: r(receivedMci), caseMci: r(consumedMci), wasteMci, wasteVials: r(wasteMci / positive(maxMciPerVial, 'MaximumMciPerVial')) };
}

/** Consumption-only estimate: opened vials = ceiling of usage; waste = opened - usage. */
function calculateOpenedVialWaste(totalActualMci, maxMciPerVial) {
  const raw = positive(totalActualMci, 'TotalActualMci') / positive(maxMciPerVial, 'MaximumMciPerVial');
  const openedVials = Math.ceil(r(raw, 6));
  const wasteVials = r(openedVials - raw);
  return { actualVials: r(raw), openedVials, wasteVials, wasteMci: r(wasteVials * maxMciPerVial) };
}

/** Powder daily waste uses the consumption-only opened-vial estimate. */
function calculatePowderDailyWaste(totalActualMci, maxMciPerVial) {
  return calculateOpenedVialWaste(totalActualMci, maxMciPerVial);
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
function fefoSelect(batches, requiredVials, { reservedByBatch = {}, serviceDate } = {}) {
  const date = String(serviceDate || '');
  const reserved = batch => Number(reservedByBatch instanceof Map ? reservedByBatch.get(batch.Batch) : reservedByBatch[batch.Batch]) || 0;
  const eligible = batches.filter(b => {
    const sled = String(b.ShelfLifeExpirationDate || '');
    const availability = String(b.BatchAvailabilityDate || '');
    return Number(b.UnrestrictedQty) - reserved(b) > 0
      && !!sled
      && b.MatlBatchIsInRstrcdUseStock !== true
      && b.BatchIsMarkedForDeletion !== true
      && b.BatchPlantIsMarkedForDeletion !== true
      && (!date || (sled >= date) && (!availability || availability <= date));
  }).sort((a, b) => String(a.ShelfLifeExpirationDate || '9999-12-31').localeCompare(String(b.ShelfLifeExpirationDate || '9999-12-31'))
      || String(a.Batch).localeCompare(String(b.Batch)));
  let remaining = r(requiredVials);
  const allocations = [];
  for (const b of eligible) {
    if (remaining <= 0) break;
    const take = r(Math.min(remaining, Number(b.UnrestrictedQty) - reserved(b)));
    allocations.push({ batch: b.Batch, shelfLifeExpirationDate: b.ShelfLifeExpirationDate, vials: take });
    remaining = r(remaining - take);
  }
  return { allocations, shortfall: Math.max(remaining, 0) };
}

/** Liquid date batches use the same available-stock and expiry guards as FEFO, with no date fallback. */
function liquidSelect(batches, serviceDate, requiredVials, { reservedByBatch = {} } = {}) {
  const prefix = liquidBatchPrefixFromServiceDate(serviceDate);
  const matching = batches.filter(batch => /^\d{6}-\d{3}$/.test(String(batch.Batch || ''))
    && String(batch.Batch).startsWith(prefix));
  matching.sort((a, b) => String(a.Batch).localeCompare(String(b.Batch)));
  return fefoSelect(matching, requiredVials, { reservedByBatch, serviceDate });
}

module.exports = { r, liquidBatchFromServiceDate, liquidBatchPrefixFromServiceDate, calculateLiquidVials, calculateLiquidDailyWaste,
  calculateOpenedVialWaste, calculatePowderDailyWaste, allocateByShare, fefoSelect, liquidSelect };
