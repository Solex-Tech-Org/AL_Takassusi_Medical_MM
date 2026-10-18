'use strict';
const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE } = cds.ql;
const calc = require('../../common/calculation/nuclear');
const payload = require('../../common/integration/payload-builder');
const { getS4Api } = require('../../common/integration/s4-material-api');
const { OPEN } = require('./case-consumption');

const E = () => cds.entities('aaml.mc');
const cfg = () => cds.env.aaml || {};
const NUCLEAR = ['NuclearLiquid', 'NuclearPowder'];
const closeResult = (c, message) => ({ DailyCloseId: c?.ID, ServiceDate: c?.ServiceDate, Version: c?.Version, Status: c?.Status,
  Message: message ?? c?.ErrorMessage, SAPMaterialDocument: c?.SAPMaterialDocument, SAPMaterialDocumentYear: c?.SAPMaterialDocumentYear });

/**
 * Calculate waste for all POSTED Nuclear primary rows of a service day, grouped per source batch
 * (Liquid: received - posted activity; Powder: ceiling(actual vials) - actual vials), then
 * allocate each batch's waste to cases by Actual mCi share. Each source batch is reconciled separately.
 */
async function computeWaste(serviceDate) {
  const { ConsumptionRequests, BatchAllocations } = E();
  const s4 = getS4Api();
  const rows = await SELECT.from(ConsumptionRequests).where({ ServiceDate: serviceDate, MaterialClass: { in: NUCLEAR }, Status: 'Posted' });
  const groups = new Map();
  for (const row of rows) {
    for (const a of await SELECT.from(BatchAllocations).where({ Request_ID: row.ID })) {
      const k = `${row.Material}|${row.Plant}|${row.StorageLocation}|${a.Batch}`;
      if (!groups.has(k)) groups.set(k, { row, batch: a.Batch, items: [] });
      groups.get(k).items.push({ row, vials: Number(a.Vials) });
    }
  }
  const lines = [];
  for (const g of groups.values()) {
    const max = Number(g.row.MaximumMciPerVial);
    const actualVials = calc.r(g.items.reduce((s, i) => s + i.vials, 0));
    const totalMci = calc.r(actualVials * max);
    let wasteVials, base;
    if (g.row.MaterialClass === 'NuclearLiquid') {
      const stock = await s4.getBatchStock({ material: g.row.Material, plant: g.row.Plant, storageLocation: g.row.StorageLocation, batch: g.batch });
      if (!stock) throw new Error(`Received quantity for batch ${g.batch} unavailable - cannot calculate Liquid waste`);
      const w = calc.calculateLiquidDailyWaste({ receivedVials: Number(stock.ReceivedQty), maxMciPerVial: max, postedMci: totalMci });
      if (w.wasteMci < 0) throw new Error(`Batch ${g.batch}: posted activity exceeds received activity`);
      wasteVials = w.wasteVials; base = Number(stock.ReceivedQty);
    } else {
      const w = calc.calculatePowderDailyWaste(totalMci, max);
      wasteVials = w.wasteVials; base = w.openedVials;
    }
    if (!(wasteVials > 0)) continue;
    const alloc = calc.allocateByShare(g.items.map(i => ({ key: i.row.ID, weight: i.vials })), wasteVials);
    const reconciled = calc.r(alloc.reduce((s, a) => s + a.amount, 0));
    if (reconciled !== calc.r(wasteVials)) throw new Error(`Batch ${g.batch}: allocations do not reconcile to waste`);
    for (const a of alloc) {
      const item = g.items.find(i => i.row.ID === a.key);
      lines.push({ row: item.row, Material: g.row.Material, Batch: g.batch, NuclearModel: g.row.NuclearModel, ActualVials: actualVials,
        OpenedOrReceivedVials: base, GroupWasteVials: wasteVials, WasteVials: a.amount, WasteMci: calc.r(a.amount * max), AllocationShare: a.share });
    }
  }
  return lines;
}

async function previewWaste(serviceDate) {
  return (await computeWaste(serviceDate)).map(l => ({ Material: l.Material, Batch: l.Batch, NuclearModel: l.NuclearModel, ActualVials: l.ActualVials,
    OpenedOrReceivedVials: l.OpenedOrReceivedVials, WasteVials: l.GroupWasteVials, WasteMci: calc.r(l.GroupWasteVials * Number(l.row.MaximumMciPerVial)),
    CaseId: l.row.CaseId, AllocationShare: l.AllocationShare, AllocatedVials: l.WasteVials }));
}

async function executeDailyClose(serviceDate) {
  const { ConsumptionRequests, DailyCloses, WasteAllocations } = E();
  const rows = await SELECT.from(ConsumptionRequests).where({ ServiceDate: serviceDate, MaterialClass: { in: NUCLEAR } });
  const open = rows.filter(r => OPEN.includes(r.Status));
  if (open.length) return { ServiceDate: serviceDate, Status: 'Incomplete', Message: `${open.length} Nuclear primary row(s) of ${serviceDate} are not yet posted or excluded` };
  if (!rows.some(r => r.Status === 'Posted')) return { ServiceDate: serviceDate, Status: 'NothingToClose', Message: 'No posted Nuclear rows' };

  const latest = (await SELECT.from(DailyCloses).where({ ServiceDate: serviceDate }).orderBy('Version desc'))[0];
  if (latest && latest.Status !== 'Reversed') {
    if (['Posted', 'NoWaste'].includes(latest.Status)) return closeResult(latest, 'Daily close already completed - existing result returned');
    return postWaste(latest);                                          // WastePending / Error -> retry with same idempotency key
  }
  let lines;
  try { lines = await computeWaste(serviceDate); }
  catch (e) { return { ServiceDate: serviceDate, Status: 'Error', Message: e.message }; }

  const ID = cds.utils.uuid(); const Version = (latest?.Version || 0) + 1;
  const close = { ID, ServiceDate: serviceDate, DailyGroupKey: serviceDate, Version, WasteVials: calc.r(lines.reduce((s, l) => s + l.WasteVials, 0)),
    Status: lines.length ? 'WastePending' : 'NoWaste', IdempotencyKey: payload.idempotencyKey(['WASTE', serviceDate, Version]) };
  await INSERT.into(DailyCloses).entries(close);
  if (!lines.length) return closeResult(close, 'No waste to post');
  await INSERT.into(WasteAllocations).entries(lines.map(l => ({ DailyClose_ID: ID, Request_ID: l.row.ID, CaseId: l.row.CaseId, Hospital: l.row.Hospital,
    Modality: l.row.Modality, Material: l.Material, Plant: l.row.Plant, StorageLocation: l.row.StorageLocation, Batch: l.Batch, NuclearModel: l.NuclearModel,
    ReceivedOrOpenedVials: l.OpenedOrReceivedVials, ActualVials: l.ActualVials, WasteVials: l.WasteVials, WasteMci: l.WasteMci, AllocationShare: l.AllocationShare,
    PrimaryDocumentReference: l.row.PrimaryDocumentReference, Status: 'Pending' })));
  await UPDATE(ConsumptionRequests).with({ DailyCloseId: ID, DailyGroupKey: serviceDate }).where({ ServiceDate: serviceDate, MaterialClass: { in: NUCLEAR }, Status: 'Posted' });
  return postWaste(close);
}

/** Automatic NM Waste posting (no user action). Idempotent via DailyCloses.IdempotencyKey. */
async function postWaste(close) {
  const { DailyCloses, WasteAllocations, PostingLogs, MovementTypeConfig } = E();
  const s4 = getS4Api();
  const allocs = await SELECT.from(WasteAllocations).where({ DailyClose_ID: close.ID });
  const mv = await SELECT.one.from(MovementTypeConfig).where({ Scenario: 'NuclearWaste' });
  const V = require('../../common/validation/validators');
  const bad = V.movementType(mv, cfg().prohibitedMovementTypes);
  const fail = async (msg, outcome) => {
    await UPDATE(DailyCloses, close.ID).with({ Status: 'Error', ErrorMessage: msg.slice(0, 500) });
    await UPDATE(WasteAllocations).with({ Status: 'Error' }).where({ DailyClose_ID: close.ID });
    await INSERT.into(PostingLogs).entries({ DailyClose_ID: close.ID, Scenario: 'NuclearWaste', IdempotencyKey: close.IdempotencyKey, Outcome: outcome, Message: msg.slice(0, 500) });
    return closeResult({ ...close, Status: 'Error' }, msg);
  };
  if (bad.length) return fail(V.msg(bad), 'BusinessError');
  const postingDate = cfg().wastePostingDateRule === 'ServiceDate' ? close.ServiceDate : new Date().toISOString().slice(0, 10); // CONFIG_PLACEHOLDER
  const body = payload.wastePosting(close, allocs, mv, close.IdempotencyKey, postingDate);
  let res;
  try { res = await s4.postMaterialDocument(body); }
  catch (e) { res = await s4.findResultByIdempotencyKey(close.IdempotencyKey).catch(() => null); if (!res) return fail(`Technical error: ${e.message}`, 'TechnicalError'); }
  if (!res.success) return fail(res.Message, 'BusinessError');
  await UPDATE(DailyCloses, close.ID).with({ Status: 'Posted', ErrorMessage: null, SAPMaterialDocument: res.MaterialDocument, SAPMaterialDocumentYear: res.MaterialDocumentYear });
  for (let i = 0; i < allocs.length; i++)
    await UPDATE(WasteAllocations, allocs[i].ID).with({ Status: 'Posted', SAPMaterialDocument: res.MaterialDocument, SAPMaterialDocumentYear: res.MaterialDocumentYear,
      SAPMaterialDocumentItem: res.Items?.[i]?.MaterialDocumentItem });
  await INSERT.into(PostingLogs).entries({ DailyClose_ID: close.ID, Scenario: 'NuclearWaste', IdempotencyKey: close.IdempotencyKey, Outcome: 'Success',
    Message: res.Message, SAPMaterialDocument: res.MaterialDocument, SAPMaterialDocumentYear: res.MaterialDocumentYear });
  return closeResult({ ...close, Status: 'Posted', SAPMaterialDocument: res.MaterialDocument, SAPMaterialDocumentYear: res.MaterialDocumentYear }, res.Message);
}

/** Reverse linked waste (must precede reversal/repost of an affected primary document). */
async function reverseWaste(dailyCloseId, reason) {
  const { DailyCloses, WasteAllocations, Reversals } = E();
  const close = await SELECT.one.from(DailyCloses).where({ ID: dailyCloseId });
  if (!close || close.Status !== 'Posted') return closeResult(close, 'Only a posted NM Waste close can be reversed');
  const res = await getS4Api().reverseMaterialDocument({ MaterialDocument: close.SAPMaterialDocument, MaterialDocumentYear: close.SAPMaterialDocumentYear,
    Reason: reason, IdempotencyKey: close.IdempotencyKey + ':REV' });
  if (!res.success) return closeResult(close, res.Message);
  await INSERT.into(Reversals).entries({ Scope: 'Waste', DailyClose_ID: close.ID, OriginalDocument: close.SAPMaterialDocument, OriginalDocumentYear: close.SAPMaterialDocumentYear,
    ReversalDocument: res.MaterialDocument, ReversalDocumentYear: res.MaterialDocumentYear, Reason: reason });
  await UPDATE(DailyCloses, close.ID).with({ Status: 'Reversed' });
  await UPDATE(WasteAllocations).with({ Status: 'Reversed' }).where({ DailyClose_ID: close.ID });
  return closeResult({ ...close, Status: 'Reversed' }, 'Waste reversed - a new daily close creates the next allocation version');
}

async function getNuclearPostingStatus(caseId) {
  const { ConsumptionRequests, WasteAllocations } = E();
  const rows = await SELECT.from(ConsumptionRequests).where({ CaseId: caseId, MaterialClass: { in: NUCLEAR } });
  const out = [];
  for (const r of rows) {
    const w = (await SELECT.from(WasteAllocations).where({ Request_ID: r.ID }))[0];
    const wasteStatus = w ? w.Status : (r.Status === 'Posted' ? 'WastePending' : 'NotApplicable');
    out.push({ CaseId: r.CaseId, PrimaryStatus: r.Status, PrimaryDocument: r.SAPMaterialDocument && `${r.SAPMaterialDocument}/${r.SAPMaterialDocumentYear}`,
      WasteStatus: wasteStatus, WasteDocument: w?.SAPMaterialDocument && `${w.SAPMaterialDocument}/${w.SAPMaterialDocumentYear}`, DailyCloseId: r.DailyCloseId });
  }
  return out;
}
module.exports = { computeWaste, previewWaste, executeDailyClose, reverseWaste, getNuclearPostingStatus };
