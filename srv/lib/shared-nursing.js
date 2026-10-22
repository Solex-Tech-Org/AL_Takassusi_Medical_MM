'use strict';
const cds = require('@sap/cds');
const { SELECT, INSERT } = cds.ql;
const V = require('../../common/validation/validators');
const payload = require('../../common/integration/payload-builder');
const { getS4Api } = require('../../common/integration/s4-material-api');
const productApi = require('../../common/integration/s4-product-api');
const E = () => cds.entities('aaml.mc');
const cfg = () => cds.env.aaml || {};

/** Hospital + Modality -> Plant / Storage Location / Cost Center (exactly one active mapping). */
async function derive(hospital, modality) {
  const maps = hospital && modality ? await SELECT.from(E().HospitalModalityMap).where({ Hospital: hospital, Modality: modality, Active: true }) : [];
  const issues = [...V.location(maps), ...V.costCenter(maps)];
  return issues.length ? { Message: V.msg(issues) } : { Plant: maps[0].Plant, StorageLocation: maps[0].StorageLocation, CostCenter: maps[0].CostCenter };
}

/** Attach Available stock when plant/storage are known. */
async function withAvailable(rows, hospital, modality) {
  const loc = await derive(hospital, modality);
  const s4 = getS4Api();
  return Promise.all(rows.map(async m => ({
    ...m,
    Available: loc.Plant
      ? await s4.getMaterialStock({ material: m.Material, plant: loc.Plant, storageLocation: loc.StorageLocation })
      : null
  })));
}

/** Local fallback: ACTIVE Nursing materials from MaterialMaster. */
async function searchLocal({ term, hospital, modality }) {
  const like = `%${String(term).toLowerCase()}%`;
  const rows = await SELECT.from(E().MaterialMaster).where({ MaterialType: 'Nursing', Active: true })
    .and('(lower(Material) like', like, 'or lower(Description) like', like, ')').limit(25);
  return withAvailable(rows.map(m => ({ Material: m.Material, Description: m.Description, BUOM: m.BaseUnit })), hospital, modality);
}

/**
 * Search materials for Shared Nursing.
 * When S4 Product API env is set, searches Product (MATNR / MAKTX / MEINS);
 * otherwise falls back to local MaterialMaster.
 */
async function search({ term, hospital, modality }) {
  const t = String(term || '').trim();
  if (t.length < 2) return [];
  if (productApi.isConfigured()) {
    const rows = await productApi.searchProducts(t);
    return withAvailable(rows, hospital, modality);
  }
  return searchLocal({ term: t, hospital, modality });
}

async function validate(input, { checkStock = true } = {}) {
  const loc = await derive(input.Hospital, input.Modality);
  const s4 = getS4Api();
  const items = []; let ok = !loc.Message;
  const mv = await SELECT.one.from(E().MovementTypeConfig).where({ Scenario: 'NursingShared' });
  const mvIssues = V.movementType(mv, cfg().prohibitedMovementTypes);
  if (!input.PostingDate) ok = false;
  // total requested per material: the same material on two lines must not exceed the stock together
  const totals = {};
  for (const it of input.Items || []) if (Number(it.Quantity) > 0) totals[it.Material] = (totals[it.Material] || 0) + Number(it.Quantity);
  for (const it of input.Items || []) {
    let master = await SELECT.one.from(E().MaterialMaster).where({ Material: it.Material });
    // Products selected from S/4 API may not exist in local MaterialMaster yet
    if (!master && productApi.isConfigured() && it.Material) {
      master = { Material: it.Material, Description: null, BaseUnit: it.BUOM, MaterialType: 'Nursing', Active: true };
    }
    const issues = V.sharedItem(it, master);
    // stock guard: Available = 0 or Quantity > Available -> blocked (only when material/qty are otherwise valid and plant/sloc were derived)
    if (checkStock && !issues.length && loc.Plant) {
      const available = await s4.getMaterialStock({ material: it.Material, plant: loc.Plant, storageLocation: loc.StorageLocation });
      issues.push(...V.sharedStock(available, totals[it.Material]));
    }
    if (issues.length) ok = false;
    items.push({ Material: it.Material, Status: issues.length ? 'Error' : 'Ready', Message: V.msg(issues) });
  }
  if (!(input.Items || []).length) ok = false;
  const itemErrors = items.filter(i => i.Status === 'Error').map(i => `${i.Material}: ${i.Message}`).join('; ');
  const message = loc.Message || V.msg(mvIssues) || (!input.PostingDate ? 'Posting Date is required' : !(input.Items || []).length ? 'Add at least one material' : itemErrors || null);
  return { ok: ok && !mvIssues.length, loc, mv, result: { Status: ok && !mvIssues.length ? 'Ready' : 'Blocked', Message: message, Items: items } };
}
const validateShared = async input => (await validate(input)).result;

/** Create entry + post to the derived Hospital/Modality cost center. No Case ID, no Nuclear logic. */
async function post(input) {
  const { SharedConsumptions, MaterialMaster } = E();
  const items = input.Items;
  const key = payload.idempotencyKey(['SHARED', input.ClientRequestId || JSON.stringify([input.PostingDate, input.Hospital, input.Modality, items])]);
  const dup = await SELECT.one.from(SharedConsumptions).where({ IdempotencyKey: key });
  // retry of an already posted request: return the stored SAP result WITHOUT re-checking stock
  // (the first posting already consumed it, so a stock check would wrongly block the retry)
  if (dup?.Status === 'Posted') {
    const v0 = await validate(input, { checkStock: false });
    return { Status: 'Posted', Message: 'Already posted - existing SAP result returned', SAPMaterialDocument: dup.SAPMaterialDocument, SAPMaterialDocumentYear: dup.SAPMaterialDocumentYear, Items: v0.result.Items };
  }
  const v = await validate(input);                                     // includes the stock check
  if (!v.ok) return v.result;

  const ID = dup?.ID || cds.utils.uuid();
  const head = { ID, PostingDate: input.PostingDate, Hospital: input.Hospital, Modality: input.Modality, ...v.loc, IdempotencyKey: key,
    CorrelationId: ID, ExternalDocumentId: `AAML-SHARED-${input.Hospital}-${input.Modality}-${ID.slice(0, 8)}` };
  const body = payload.shared(head, items, v.mv, key);
  let res;
  try { res = await getS4Api().postMaterialDocument(body); }
  catch (e) { res = await getS4Api().findResultByIdempotencyKey(key).catch(() => null) || { success: false, Message: `Technical error: ${e.message}` }; }
  const rows = await Promise.all(items.map(async (it, i) => ({ Line: i + 1, Material: it.Material, Quantity: it.Quantity, BUOM: it.BUOM,
    MaterialDescription: (await SELECT.one.from(MaterialMaster).where({ Material: it.Material }))?.Description || it.Description || null,
    SAPMaterialDocumentItem: res.Items?.[i]?.MaterialDocumentItem, Message: res.success ? null : res.Message })));
  if (!dup) await INSERT.into(SharedConsumptions).entries({ ...head, Status: res.success ? 'Posted' : 'Error', ErrorMessage: res.success ? null : res.Message?.slice(0, 500),
    SAPMaterialDocument: res.MaterialDocument, SAPMaterialDocumentYear: res.MaterialDocumentYear, Items: rows });
  else await cds.ql.UPDATE(SharedConsumptions, ID).with({ Status: res.success ? 'Posted' : 'Error', ErrorMessage: res.success ? null : res.Message?.slice(0, 500),
    SAPMaterialDocument: res.MaterialDocument, SAPMaterialDocumentYear: res.MaterialDocumentYear });
  await INSERT.into(E().PostingLogs).entries({ Shared_ID: ID, Scenario: 'NursingShared', IdempotencyKey: key, Outcome: res.success ? 'Success' : 'BusinessError',
    Message: res.Message?.slice(0, 500), SAPMaterialDocument: res.MaterialDocument, SAPMaterialDocumentYear: res.MaterialDocumentYear });
  return { Status: res.success ? 'Posted' : 'Error', Message: res.Message, SAPMaterialDocument: res.MaterialDocument, SAPMaterialDocumentYear: res.MaterialDocumentYear,
    Items: v.result.Items.map((r, i) => ({ ...r, Status: res.success ? 'Posted' : 'Error', SAPMaterialDocumentItem: res.Items?.[i]?.MaterialDocumentItem })) };
}
module.exports = { derive, search, validate: validateShared, post };