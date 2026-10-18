'use strict';
const cds = require('@sap/cds');
const { SELECT, INSERT } = cds.ql;
const V = require('../../common/validation/validators');
const payload = require('../../common/integration/payload-builder');
const { getS4Api } = require('../../common/integration/s4-material-api');
const E = () => cds.entities('aaml.mc');
const cfg = () => cds.env.aaml || {};

/** Hospital + Modality -> Plant / Storage Location / Cost Center (exactly one active mapping). */
async function derive(hospital, modality) {
  const maps = hospital && modality ? await SELECT.from(E().HospitalModalityMap).where({ Hospital: hospital, Modality: modality, Active: true }) : [];
  const issues = [...V.location(maps), ...V.costCenter(maps)];
  return issues.length ? { Message: V.msg(issues) } : { Plant: maps[0].Plant, StorageLocation: maps[0].StorageLocation, CostCenter: maps[0].CostCenter };
}

/** Search ACTIVE Nursing materials only; nothing is preloaded. */
async function search({ term, hospital, modality }) {
  const t = String(term || '').trim();
  if (t.length < 2) return [];
  const like = `%${t.toLowerCase()}%`;
  const rows = await SELECT.from(E().MaterialMaster).where({ MaterialType: 'Nursing', Active: true })
    .and('(lower(Material) like', like, 'or lower(Description) like', like, ')').limit(25);
  const loc = await derive(hospital, modality);
  const s4 = getS4Api();
  return Promise.all(rows.map(async m => ({ Material: m.Material, Description: m.Description, BUOM: m.BaseUnit,
    Available: loc.Plant ? await s4.getMaterialStock({ material: m.Material, plant: loc.Plant, storageLocation: loc.StorageLocation }) : null })));
}

async function validate(input) {
  const loc = await derive(input.Hospital, input.Modality);
  const items = []; let ok = !loc.Message;
  const mv = await SELECT.one.from(E().MovementTypeConfig).where({ Scenario: 'NursingShared' });
  const mvIssues = V.movementType(mv, cfg().prohibitedMovementTypes);
  if (!input.PostingDate) ok = false;
  for (const it of input.Items || []) {
    const master = await SELECT.one.from(E().MaterialMaster).where({ Material: it.Material });
    const issues = V.sharedItem(it, master);
    if (issues.length) ok = false;
    items.push({ Material: it.Material, Status: issues.length ? 'Error' : 'Ready', Message: V.msg(issues) });
  }
  if (!(input.Items || []).length) ok = false;
  const message = loc.Message || V.msg(mvIssues) || (!input.PostingDate ? 'Posting Date is required' : !(input.Items || []).length ? 'Add at least one material' : null);
  return { ok: ok && !mvIssues.length, loc, mv, result: { Status: ok && !mvIssues.length ? 'Ready' : 'Blocked', Message: message, Items: items } };
}
const validateShared = async input => (await validate(input)).result;

/** Create entry + post to the derived Hospital/Modality cost center. No Case ID, no Nuclear logic. */
async function post(input) {
  const { SharedConsumptions, MaterialMaster } = E();
  const v = await validate(input);
  if (!v.ok) return v.result;
  const items = input.Items;
  const key = payload.idempotencyKey(['SHARED', input.ClientRequestId || JSON.stringify([input.PostingDate, input.Hospital, input.Modality, items])]);
  const dup = await SELECT.one.from(SharedConsumptions).where({ IdempotencyKey: key });
  if (dup?.Status === 'Posted') return { Status: 'Posted', Message: 'Already posted - existing SAP result returned', SAPMaterialDocument: dup.SAPMaterialDocument, SAPMaterialDocumentYear: dup.SAPMaterialDocumentYear, Items: v.result.Items };

  const ID = dup?.ID || cds.utils.uuid();
  const head = { ID, PostingDate: input.PostingDate, Hospital: input.Hospital, Modality: input.Modality, ...v.loc, IdempotencyKey: key,
    CorrelationId: ID, ExternalDocumentId: `AAML-SHARED-${input.Hospital}-${input.Modality}-${ID.slice(0, 8)}` };
  const body = payload.shared(head, items, v.mv, key);
  let res;
  try { res = await getS4Api().postMaterialDocument(body); }
  catch (e) { res = await getS4Api().findResultByIdempotencyKey(key).catch(() => null) || { success: false, Message: `Technical error: ${e.message}` }; }
  const rows = await Promise.all(items.map(async (it, i) => ({ Line: i + 1, Material: it.Material, Quantity: it.Quantity, BUOM: it.BUOM,
    MaterialDescription: (await SELECT.one.from(MaterialMaster).where({ Material: it.Material }))?.Description,
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
