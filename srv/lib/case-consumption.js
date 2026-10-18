'use strict';
const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const calc = require('../../common/calculation/nuclear');
const V = require('../../common/validation/validators');
const { determine } = require('../../common/determination/material-determination');
const { normalizeRisRow } = require('../../common/integration/ris-adapter');
const payload = require('../../common/integration/payload-builder');
const { getS4Api } = require('../../common/integration/s4-material-api');

const E = () => cds.entities('aaml.mc');
const cfg = () => cds.env.aaml || {};
const OPEN = ['Received', 'Ready', 'Blocked', 'NeedsCorrection'];
const result = (row, message) => ({ ID: row.ID, CaseId: row.CaseId, Status: row.Status, Message: message ?? row.ErrorMessage,
  SAPMaterialDocument: row.SAPMaterialDocument, SAPMaterialDocumentYear: row.SAPMaterialDocumentYear, SAPMaterialDocumentItem: row.SAPMaterialDocumentItem });

// ---------------------------------------------------------------- RIS intake
async function receiveFromRis(rows) {
  const { ConsumptionRequests, ValidationEvents } = E();
  const out = [];
  for (const raw of rows) {
    const { row, events } = normalizeRisRow(raw, cfg().ris?.serviceTimeZone);
    const existing = row.SourceRecordId && await SELECT.one.from(ConsumptionRequests).where({ SourceRecordId: row.SourceRecordId });
    let id;
    if (existing) {
      if (row.Version <= (existing.Version || 1) && row.Action !== 'Cancel') { out.push(result(existing, 'Stale/duplicate RIS version ignored')); continue; }
      if (existing.Status === 'Posted') {
        await INSERT.into(ValidationEvents).entries({ Request_ID: existing.ID, Source: 'RIS', Code: 'CHANGE_AFTER_POST',
          Message: 'Change/cancel received after posting - reverse the posted document first' });
        out.push(result(existing, 'Already posted - reversal required before change/cancel')); continue; }
      id = existing.ID;
      if (row.Action === 'Cancel') { await UPDATE(ConsumptionRequests, id).with({ Status: 'Excluded', Version: row.Version, ErrorMessage: 'Cancelled by RIS' });
        out.push(result({ ...existing, Status: 'Excluded' })); continue; }
      const reopen = existing.Status === 'Reversed' ? { Status: 'Received', PostingVersion: existing.PostingVersion + 1, SAPMaterialDocument: null, SAPMaterialDocumentYear: null, SAPMaterialDocumentItem: null, IdempotencyKey: null } : {};
      await UPDATE(ConsumptionRequests, id).with({ ...row, ...reopen });
    } else {
      const mandatory = V.waitingRow({ ...row, Status: 'Received' });
      // keep incomplete rows visible in Blocked state; duplicates impossible (unique SourceRecordId)
      id = cds.utils.uuid();
      await INSERT.into(ConsumptionRequests).entries({ ID: id, ...row, Status: 'Received',
        CorrelationId: row.CorrelationId || id, ExternalDocumentId: `AAML-${row.CaseId}-${row.SourceRecordId}`,
        ErrorMessage: V.msg(mandatory) || null });
    }
    for (const e of events) await INSERT.into(ValidationEvents).entries({ Request_ID: id, ...e });
    out.push(result(await prepareRow(id)));
  }
  return out;
}

// ---------------------------------------------------------------- determination + calculation + validation
async function prepareRow(id) {
  const { ConsumptionRequests, BatchAllocations } = E();
  const row = await SELECT.one.from(ConsumptionRequests).where({ ID: id });
  if (!row || !OPEN.includes(row.Status)) return row;
  const s4 = getS4Api();
  const det = await determine(row, cfg().prohibitedMovementTypes);
  const issues = [...V.waitingRow(row), ...det.issues];
  const upd = { Material: det.material, MaterialDescription: det.master?.Description, MaterialClass: det.materialClass,
    NuclearModel: det.master?.NuclearModel, PostingScenario: det.scenario, Plant: det.location?.Plant, StorageLocation: det.location?.StorageLocation,
    CostCenter: det.location?.CostCenter, MaximumMciPerVial: det.master?.MaxMciPerVial, PostingCategory: null,
    CalculatedVials: null, Batch: null, BatchSource: null, EstimatedWaste: null };
  await DELETE.from(BatchAllocations).where({ Request_ID: id });

  if (det.materialClass === 'Normal') issues.push(...V.normalQuantity(row));

  if (det.materialClass?.startsWith('Nuclear')) {
    upd.PostingCategory = 'NMConsumption'; upd.EntryUnit = row.EntryUnit;
    const nuc = V.nuclearActivity(row, det.master.MaxMciPerVial); issues.push(...nuc);
    if (!nuc.length && det.location && !issues.length) {
      const vials = calc.calculateLiquidVials(row.ActualMci, det.master.MaxMciPerVial);
      upd.CalculatedVials = vials;
      const where = { material: det.material, plant: det.location.Plant, storageLocation: det.location.StorageLocation };
      if (det.materialClass === 'NuclearLiquid') {
        const batch = calc.liquidBatchFromServiceDate(row.ServiceDate);       // exact date, no FEFO, no fallback
        const stock = await s4.getBatchStock({ ...where, batch });
        const bi = V.liquidBatch(stock, vials, batch); issues.push(...bi);
        upd.Batch = batch; upd.BatchSource = 'LIQUID_EXACT_DATE';
        if (!bi.length) await INSERT.into(BatchAllocations).entries({ Request_ID: id, Sequence: 1, Batch: batch,
          ShelfLifeExpirationDate: stock.ShelfLifeExpirationDate, Vials: vials, Mci: row.ActualMci });
      } else {
        const pick = calc.fefoSelect(await s4.listBatchStock(where), vials);
        const bi = V.powderBatch(pick); issues.push(...bi);
        upd.BatchSource = 'FEFO'; upd.Batch = pick.allocations.map(a => a.batch).join(',') || null;
        if (!bi.length) {
          await INSERT.into(BatchAllocations).entries(pick.allocations.map((a, i) => ({ Request_ID: id, Sequence: i + 1, Batch: a.batch,
            ShelfLifeExpirationDate: a.shelfLifeExpirationDate, Vials: a.vials, Mci: calc.r(a.vials * det.master.MaxMciPerVial) })));
          upd.EstimatedWaste = await estimatePowderWaste(row, det.material, det.master.MaxMciPerVial);
        }
      }
    }
  }
  upd.Status = issues.length ? 'Blocked' : 'Ready';
  upd.ErrorMessage = issues.length ? V.msg(issues).slice(0, 500) : null;
  if (upd.Status === 'Ready' && !row.IdempotencyKey)
    upd.IdempotencyKey = payload.idempotencyKey(['CASE', row.SourceRecordId, row.Version, row.PostingVersion]);
  await UPDATE(E().ConsumptionRequests, id).with(upd);
  return SELECT.one.from(E().ConsumptionRequests).where({ ID: id });
}

/** Powder estimate: this row's share of today's rounding waste (all open/posted Powder rows of the day). */
async function estimatePowderWaste(row, material, max) {
  const { ConsumptionRequests } = E();
  const day = await SELECT.from(ConsumptionRequests).where({ ServiceDate: row.ServiceDate, Material: material,
    Status: { 'not in': ['Excluded', 'Reversed', 'Blocked'] } });
  const total = day.reduce((s, d) => s + Number(d.ActualMci), 0) + (day.some(d => d.ID === row.ID) ? 0 : Number(row.ActualMci));
  const w = calc.calculatePowderDailyWaste(total, max);
  return calc.r(w.wasteVials * Number(row.ActualMci) / total);
}

async function calculateRows(ids) { const out = []; for (const id of ids) out.push(result(await prepareRow(id))); return out; }

// ---------------------------------------------------------------- posting
async function postSelected(ids) {
  const { ConsumptionRequests, PostingLogs, BatchAllocations } = E();
  const s4 = getS4Api(); const out = [];
  for (const id of ids) {
    let row = await SELECT.one.from(ConsumptionRequests).where({ ID: id });
    if (!row) { out.push({ ID: id, Status: 'NotFound', Message: 'Row not found' }); continue; }
    if (row.Status === 'Posted' || row.SAPMaterialDocument) { out.push(result(row, 'Already posted - existing SAP result returned')); continue; }
    row = await prepareRow(id);                                        // re-validate right before posting
    if (row.Status !== 'Ready') { out.push(result(row)); continue; }
    const mv = await SELECT.one.from(E().MovementTypeConfig).where({ Scenario: row.PostingScenario });
    const allocs = await SELECT.from(BatchAllocations).where({ Request_ID: id }).orderBy('Sequence');
    const lines = row.MaterialClass === 'Normal'
      ? [{ quantity: row.Quantity, unit: row.EntryUnit }]
      : allocs.map(a => ({ quantity: a.Vials, unit: 'Vial', batch: a.Batch, batchSource: row.BatchSource }));
    const body = payload.casePrimary(row, lines, mv);
    let res;
    try { res = await s4.postMaterialDocument(body); }
    catch (e) {                                                         // technical error: check for existing SAP result before retry
      res = await s4.findResultByIdempotencyKey(row.IdempotencyKey).catch(() => null);
      if (!res) {
        await INSERT.into(PostingLogs).entries({ Request_ID: id, Scenario: row.PostingScenario, IdempotencyKey: row.IdempotencyKey, Outcome: 'TechnicalError', Message: String(e.message).slice(0, 500) });
        out.push({ ...result(row), Message: 'Technical error, no SAP result found. Safe to retry (same idempotency key).' }); continue;
      }
    }
    if (!res.success) {
      await UPDATE(ConsumptionRequests, id).with({ Status: 'NeedsCorrection', ErrorMessage: String(res.Message).slice(0, 500) });
      await INSERT.into(PostingLogs).entries({ Request_ID: id, Scenario: row.PostingScenario, IdempotencyKey: row.IdempotencyKey, Outcome: 'BusinessError', Message: String(res.Message).slice(0, 500) });
      out.push(result({ ...row, Status: 'NeedsCorrection' }, res.Message)); continue;
    }
    const item = res.Items?.[0]?.MaterialDocumentItem;
    await UPDATE(ConsumptionRequests, id).with({ Status: 'Posted', ErrorMessage: null, SAPMaterialDocument: res.MaterialDocument,
      SAPMaterialDocumentYear: res.MaterialDocumentYear, SAPMaterialDocumentItem: item,
      PrimaryDocumentReference: `${res.MaterialDocument}/${res.MaterialDocumentYear}/${item}` });
    await INSERT.into(PostingLogs).entries({ Request_ID: id, Scenario: row.PostingScenario, IdempotencyKey: row.IdempotencyKey, Outcome: 'Success',
      Message: res.Message, SAPMaterialDocument: res.MaterialDocument, SAPMaterialDocumentYear: res.MaterialDocumentYear });
    out.push(result(await SELECT.one.from(ConsumptionRequests).where({ ID: id }), res.Message));
  }
  return out;
}

// ---------------------------------------------------------------- reversal (primary)
async function reversePrimary({ ID, reason, repost }, user) {
  const { ConsumptionRequests, WasteAllocations, Reversals } = E();
  const row = await SELECT.one.from(ConsumptionRequests).where({ ID });
  if (!row || row.Status !== 'Posted') return { ID, Status: row?.Status, Message: 'Only posted rows can be reversed' };
  const linked = await SELECT.from(WasteAllocations).where({ Request_ID: ID, Status: 'Posted' });
  if (linked.length) return { ...result(row), Message: 'Reverse the linked NM Waste document first (reverseWaste)' };
  const res = await getS4Api().reverseMaterialDocument({ MaterialDocument: row.SAPMaterialDocument, MaterialDocumentYear: row.SAPMaterialDocumentYear,
    Reason: reason, IdempotencyKey: row.IdempotencyKey + ':REV' });
  if (!res.success) return { ...result(row), Message: res.Message };
  await INSERT.into(Reversals).entries({ Scope: 'Primary', Request_ID: ID, OriginalDocument: row.SAPMaterialDocument, OriginalDocumentYear: row.SAPMaterialDocumentYear,
    ReversalDocument: res.MaterialDocument, ReversalDocumentYear: res.MaterialDocumentYear, Reason: reason });
  await UPDATE(ConsumptionRequests, ID).with({ Status: 'Reversed', PostingVersion: row.PostingVersion + 1 });
  if (repost) {                                                         // reopen for correction + repost (new idempotency key)
    await UPDATE(ConsumptionRequests, ID).with({ Status: 'Received', IdempotencyKey: null, SAPMaterialDocument: null, SAPMaterialDocumentYear: null, SAPMaterialDocumentItem: null, PrimaryDocumentReference: null });
    return result(await prepareRow(ID), 'Reversed and reopened for repost');
  }
  return result({ ...row, Status: 'Reversed' }, 'Reversed');
}

// ---------------------------------------------------------------- Nuclear helper functions
const determineLiquidBatch = serviceDate => calc.liquidBatchFromServiceDate(serviceDate);
async function determinePowderBatch({ material, hospital, modality, vials }) {
  const loc = await SELECT.one.from(E().HospitalModalityMap).where({ Hospital: hospital, Modality: modality, Active: true });
  if (!loc) return [];
  const pick = calc.fefoSelect(await getS4Api().listBatchStock({ material, plant: loc.Plant, storageLocation: loc.StorageLocation }), vials);
  return pick.allocations.map(a => ({ Batch: a.batch, ShelfLifeExpirationDate: a.shelfLifeExpirationDate, Vials: a.vials }));
}
module.exports = { receiveFromRis, prepareRow, calculateRows, postSelected, reversePrimary, determineLiquidBatch, determinePowderBatch, OPEN };
