'use strict';
/**
 * RIS integration abstraction (FSD 6.1). RIS pushes source rows through the
 * `receiveFromRis` action; a pull client can be added later behind this module.
 * Canonical names are accepted as-is; RIS source names are mapped.
 * CONFIG_PLACEHOLDER: precedence for Hospital / Modality / ServiceDate is "to confirm" in the FSD
 * - first non-empty candidate in the list wins until confirmed.
 */
const SOURCE_FIELDS = {
    CaseId: ['CaseId', 'PROCEDURE_KEY'],
    SourceRecordId: ['SourceRecordId'],            // final RIS field to confirm
    ProcedureCode: ['ProcedureCode', 'PROCEDURE_CODE'],
    Material: ['Material'],
    ServiceDateTime: ['ServiceDateTime', 'PROCEDURE_END'],
    Hospital: ['Hospital', 'Scan_Hospital'],
    Modality: ['Modality'],
    Quantity: ['Quantity'], EntryUnit: ['EntryUnit'], ActualMci: ['ActualMci'],
    Action: ['Action'], Version: ['Version'], SourceTimestamp: ['SourceTimestamp'], CorrelationId: ['CorrelationId']
};
const pick = (raw, names) => { for (const n of names) if (raw[n] !== undefined && raw[n] !== null && raw[n] !== '') return raw[n]; };

function toServiceDate(ts, tz = 'UTC') {
    if (!ts) return undefined;
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

/** @returns {{row:object, events:object[]}} - Batch from RIS is never copied; a validation event is recorded. */
function normalizeRisRow(raw, tz) {
    const row = {}; const events = [];
    for (const [k, names] of Object.entries(SOURCE_FIELDS)) { const v = pick(raw, names); if (v !== undefined) row[k] = v; }
    row.ServiceDate = toServiceDate(row.ServiceDateTime, tz);
    row.Action = row.Action || 'Create';
    row.Version = Number(row.Version || 1);
    if (raw.Batch) events.push({ Source: 'RIS', Code: 'BATCH_IGNORED', Message: `Batch '${raw.Batch}' received from RIS was ignored; the system determines the batch` });
    return { row, events };
}
module.exports = { normalizeRisRow, toServiceDate };
