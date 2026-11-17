'use strict';
const cds = require('@sap/cds');
const { SELECT, INSERT, DELETE } = cds.ql;

const E = () => cds.entities('aaml.mc');
const OPEN = ['Received', 'Ready', 'Blocked', 'NeedsCorrection'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ID_CHUNK_SIZE = 500;

async function selectByIds(entity, column, ids) {
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK_SIZE) {
    rows.push(...await SELECT.from(entity).where({ [column]: { in: ids.slice(offset, offset + ID_CHUNK_SIZE) } }));
  }
  return rows;
}

async function deleteByIds(entity, column, ids) {
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK_SIZE) {
    await DELETE.from(entity).where({ [column]: { in: ids.slice(offset, offset + ID_CHUNK_SIZE) } });
  }
}

/** إجمالي / اتعمله Post / المتبقي لفترة معيّنة (من ConsumptionRequests). */
async function counts(dateFrom, dateTo) {
  const { ConsumptionRequests } = E();
  const rows = await SELECT.from(ConsumptionRequests).columns('Status', 'count(*) as n')
    .where({ ServiceDate: { between: dateFrom, and: dateTo }, Status: { in: [...OPEN, 'Posted'] } })
    .groupBy('Status');
  const by = Object.fromEntries(rows.map(r => [r.Status, Number(r.n)]));
  const posted = by.Posted || 0;
  const remaining = OPEN.reduce((a, s) => a + (by[s] || 0), 0);
  return { TotalCases: posted + remaining, PostedCases: posted, RemainingCases: remaining,
    SessionStatus: remaining > 0 ? 'Open' : 'Completed' };
}

/** after READ CaseSessions: بيملي الحقول المحسوبة. */
async function fillCounts(result) {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  await Promise.all(list.map(async s => {
    if (s.DateFrom && s.DateTo) { Object.assign(s, await counts(s.DateFrom, s.DateTo)); }
  }));
}

/** openSession(dateFrom, dateTo): بيعمل معاملة جديدة، ويرفض أي فترة متقاطعة مع معاملة موجودة. */
async function createSession(dateFrom, dateTo, req) {
  const reject = (status, message) => {
    if (req && req.reject) return req.reject(status, message);
    const error = new Error(message);
    error.statusCode = status;
    throw error;
  };
  if (!ISO.test(dateFrom || '') || !ISO.test(dateTo || '')) { return reject(400, 'dateFrom and dateTo are required (yyyy-MM-dd)'); }
  if (dateFrom > dateTo) { return reject(400, 'dateFrom must not be after dateTo'); }
  const { ConsumptionSessions } = E();
  // أي فترة بتتقاطع مع معاملة موجودة (نفس الفترة أو جزء منها أو أكبر منها) بتتقفل برسالة واضحة.
  const clash = await SELECT.one.from(ConsumptionSessions)
    .where({ DateFrom: { '<=': dateTo }, DateTo: { '>=': dateFrom } }).orderBy('DateFrom');
  if (clash) {
    return reject(409, `This period already exists: transaction ${clash.SessionNo} (${clash.DateFrom} to ${clash.DateTo}). Open it from Previous transactions.`);
  }

  const existingNumbers = await SELECT.from(ConsumptionSessions).columns('SessionNo');
  const lastNumber = existingNumbers.reduce((max, row) => {
    const match = /^CS-(\d+)$/i.exec(String(row.SessionNo || ''));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const no = `CS-${String(lastNumber + 1).padStart(4, '0')}`;
  const ID = cds.utils.uuid();
  await INSERT.into(ConsumptionSessions).entries({ ID, SessionNo: no, DateFrom: dateFrom, DateTo: dateTo });
  const row = await SELECT.one.from(ConsumptionSessions).where({ ID });
  return row;
}

async function openSession(req) {
  const row = await createSession(req.data.dateFrom, req.data.dateTo, req);
  return { ...row, ...(await counts(row.DateFrom, row.DateTo)) };
}

async function getOrCreateSession(dateFrom, dateTo, req) {
  const { ConsumptionSessions } = E();
  // Reuse an existing transaction when the requested import period is fully
  // inside it (for example, import 3-4 into an existing 3-5 transaction).
  // This avoids creating an overlapping transaction while still allowing new
  // case rows to be appended to the transaction that owns those service dates.
  const existing = await SELECT.one.from(ConsumptionSessions)
    .where({ DateFrom: { '<=': dateFrom }, DateTo: { '>=': dateTo } })
    .orderBy('DateFrom');
  return existing || createSession(dateFrom, dateTo, req);
}

/** Remove a period and its unposted case rows so an import can be retried cleanly. */
async function deleteSession(req) {
  const reject = (status, message) => req.reject(status, message);
  const ID = String(req.data.ID || '').trim();
  if (!ID) return reject(400, 'Transaction ID is required.');

  const { ConsumptionSessions, ConsumptionRequests, BatchAllocations, ValidationEvents,
    PostingLogs, WasteAllocations, DailyCloses, Reversals } = E();
  const session = await SELECT.one.from(ConsumptionSessions).where({ ID });
  if (!session) return reject(404, 'Transaction was not found.');

  const rows = await SELECT.from(ConsumptionRequests)
    .columns('ID', 'Status', 'SAPMaterialDocument', 'DailyCloseId')
    .where({ ServiceDate: { between: session.DateFrom, and: session.DateTo } });
  const requestIds = rows.map(row => row.ID);
  const unsafeRows = rows.filter(row => ['Posted', 'Reversed'].includes(row.Status) || row.SAPMaterialDocument);
  if (unsafeRows.length) {
    return reject(409, `Cannot delete ${session.SessionNo}: ${unsafeRows.length} case(s) are posted, reversed, or have an SAP material document.`);
  }

  const [requestLogs, allocations, reversals] = requestIds.length ? await Promise.all([
    selectByIds(PostingLogs, 'Request_ID', requestIds),
    selectByIds(WasteAllocations, 'Request_ID', requestIds),
    selectByIds(Reversals, 'Request_ID', requestIds)
  ]) : [[], [], []];
  const unsafeAllocations = allocations.filter(row => ['Posted', 'Reversed'].includes(row.Status) || row.SAPMaterialDocument);
  const uncertainPosting = requestLogs.some(row => ['Success', 'TechnicalError'].includes(row.Outcome));
  if (unsafeAllocations.length || reversals.length || uncertainPosting) {
    return reject(409, `Cannot delete ${session.SessionNo}: related SAP posting history exists.`);
  }

  const closeIds = [...new Set([
    ...rows.map(row => row.DailyCloseId),
    ...allocations.map(row => row.DailyClose_ID)
  ].filter(Boolean))];
  if (closeIds.length) {
    const [closes, logs, closeReversals] = await Promise.all([
      selectByIds(DailyCloses, 'ID', closeIds),
      selectByIds(PostingLogs, 'DailyClose_ID', closeIds),
      selectByIds(Reversals, 'DailyClose_ID', closeIds)
    ]);
    if (closes.some(row => ['Posted', 'Reversed'].includes(row.Status) || row.SAPMaterialDocument) ||
        logs.some(row => ['Success', 'TechnicalError'].includes(row.Outcome)) || closeReversals.length) {
      return reject(409, `Cannot delete ${session.SessionNo}: related nuclear waste posting history exists.`);
    }
  }

  if (requestIds.length) {
    await deleteByIds(BatchAllocations, 'Request_ID', requestIds);
    await deleteByIds(ValidationEvents, 'Request_ID', requestIds);
    await deleteByIds(PostingLogs, 'Request_ID', requestIds);
    await deleteByIds(WasteAllocations, 'Request_ID', requestIds);
    await deleteByIds(ConsumptionRequests, 'ID', requestIds);
  }
  if (closeIds.length) {
    await deleteByIds(PostingLogs, 'DailyClose_ID', closeIds);
    await deleteByIds(WasteAllocations, 'DailyClose_ID', closeIds);
    await deleteByIds(DailyCloses, 'ID', closeIds);
  }
  await DELETE.from(ConsumptionSessions).where({ ID });
  return { ID, SessionNo: session.SessionNo, DeletedCases: requestIds.length };
}

module.exports = { counts, fillCounts, createSession, getOrCreateSession, openSession, deleteSession };
