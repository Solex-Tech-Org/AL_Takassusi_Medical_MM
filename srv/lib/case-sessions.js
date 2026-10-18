'use strict';
const cds = require('@sap/cds');
const { SELECT, INSERT } = cds.ql;

const E = () => cds.entities('aaml.mc');
const OPEN = ['Received', 'Ready', 'Blocked', 'NeedsCorrection'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

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
async function openSession(req) {
  const { dateFrom, dateTo } = req.data;
  if (!ISO.test(dateFrom || '') || !ISO.test(dateTo || '')) { return req.reject(400, 'dateFrom and dateTo are required (yyyy-MM-dd)'); }
  if (dateFrom > dateTo) { return req.reject(400, 'dateFrom must not be after dateTo'); }

  const { ConsumptionSessions } = E();
  // أي فترة بتتقاطع مع معاملة موجودة (نفس الفترة أو جزء منها أو أكبر منها) بتتقفل برسالة واضحة.
  const clash = await SELECT.one.from(ConsumptionSessions)
    .where({ DateFrom: { '<=': dateTo }, DateTo: { '>=': dateFrom } }).orderBy('DateFrom');
  if (clash) {
    return req.reject(409, `This period already exists: transaction ${clash.SessionNo} (${clash.DateFrom} to ${clash.DateTo}). Open it from Previous transactions.`);
  }

  const last = await SELECT.one.from(ConsumptionSessions).columns('count(*) as n');
  const no = `CS-${String(Number(last?.n || 0) + 1).padStart(4, '0')}`;
  const ID = cds.utils.uuid();
  await INSERT.into(ConsumptionSessions).entries({ ID, SessionNo: no, DateFrom: dateFrom, DateTo: dateTo });
  const row = await SELECT.one.from(ConsumptionSessions).where({ ID });
  return { ...row, ...(await counts(row.DateFrom, row.DateTo)) };
}

module.exports = { counts, fillCounts, openSession };