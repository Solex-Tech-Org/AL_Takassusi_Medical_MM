'use strict';
const crypto = require('crypto');
const cds = require('@sap/cds');
const log = cds.log('case-consumption');
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const calc = require('../../common/calculation/nuclear');
const V = require('../../common/validation/validators');
const { determine } = require('../../common/determination/material-determination');
const { normalizeRisRow } = require('../../common/integration/ris-adapter');
const payload = require('../../common/integration/payload-builder');
const { getS4Api, NotConfiguredError, getRemotePostingConfigIssues } = require('../../common/integration/s4-material-api');
const { remoteReadsEnabled, remotePostingEnabled } = require('../../common/integration/s4-config');
const slocApi = require('../../common/integration/s4-sloc-api');

const E = () => cds.entities('aaml.mc');
const cfg = () => cds.env.aaml || {};
const OPEN = ['Received', 'Ready', 'Blocked', 'NeedsCorrection', 'Error'];
const isUnconfirmedPost = row => row?.Status === 'Error' && /Do not retry until the document is checked in SAP/i.test(row.ErrorMessage || '');
const fromCodeFields = row => row && ({ ...row, Hospital: row.Hospital_Code ?? row.Hospital, Modality: row.Modality_Code ?? row.Modality });
const reject = (req, status, message) => {
    if (req) return req.reject(status, message);
    throw Object.assign(new Error(message), { statusCode: status });
};
const toCodeFields = row => {
    const { Hospital, Modality, ...fields } = row;
    if (Object.prototype.hasOwnProperty.call(row, 'Hospital')) fields.Hospital_Code = Hospital || null;
    if (Object.prototype.hasOwnProperty.call(row, 'Modality')) fields.Modality_Code = Modality || null;
    return fields;
};
const result = (row, message) => ({ ID: row.ID, CaseId: row.CaseId, Status: row.Status, Message: message ?? row.ErrorMessage,
    SAPMaterialDocument: row.SAPMaterialDocument, SAPMaterialDocumentYear: row.SAPMaterialDocumentYear, SAPMaterialDocumentItem: row.SAPMaterialDocumentItem });
const isIsoServiceDate = value => {
    const date = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};

function externalDocumentIdFor(row) {
    const prefix = `AAML-${row.CaseId}-`;
    const sourceRecordId = String(row.SourceRecordId || '');
    const candidate = `${prefix}${sourceRecordId}`;
    if (candidate.length <= 80) return candidate;
    const digest = crypto.createHash('sha256').update(sourceRecordId).digest('hex').slice(0, 16);
    const sourceLength = Math.max(0, 80 - prefix.length - digest.length - 1);
    return `${prefix}${sourceRecordId.slice(0, sourceLength)}-${digest}`;
}

// ---------------------------------------------------------------- RIS intake
async function receiveFromRis(rows, req) {
    const { ConsumptionRequests, ValidationEvents, Hospitals, Modalities } = E();
    if (!Array.isArray(rows)) return reject(req, 400, 'RIS rows must be provided as an array.');
    const [hospitalRows, modalityRows] = await Promise.all([
        SELECT.from(Hospitals).columns('Code'), SELECT.from(Modalities).columns('Code')
    ]);
    const hospitalCodes = new Set(hospitalRows.map(item => item.Code));
    const modalityCodes = new Set(modalityRows.map(item => item.Code));
    const normalized = rows.map(raw => normalizeRisRow(raw, {
        timeZone: cfg().ris?.serviceTimeZone,
        fieldMap: cfg().ris?.fieldMap
    }));
    for (const { row } of normalized) {
        const timestampHasOffset = row.ServiceDateTime instanceof Date
            || /(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(row.ServiceDateTime || ''));
        if (!row.ServiceDate && timestampHasOffset && !cfg().ris?.serviceTimeZone)
            return reject(req, 400, 'Configure cds.aaml.ris.serviceTimeZone before deriving ServiceDate from an offset timestamp.');
        if (row.ServiceDate != null && !isIsoServiceDate(row.ServiceDate))
            return reject(req, 400, `Invalid ServiceDate '${row.ServiceDate}'. Use YYYY-MM-DD or configure an ISO service timestamp.`);
        if (!row.SourceRecordId) {
            const identity = [row.CaseId, row.ServiceDate, row.Hospital, row.Modality, row.ProcedureCode, row.RISMaterialCode].join('|');
            row.SourceRecordId = `RIS-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 64)}`;
        }
        if (row.Hospital != null) row.Hospital = String(row.Hospital).trim() || null;
        if (row.Modality != null) row.Modality = String(row.Modality).trim() || null;
        if (row.RISMaterialCode != null) row.RISMaterialCode = String(row.RISMaterialCode).trim() || null;
        if (row.Hospital && !hospitalCodes.has(row.Hospital))
            return reject(req, 400, `Unknown Hospital code '${row.Hospital}'. Read valid codes from the Hospitals entity.`);
        if (row.Modality && !modalityCodes.has(row.Modality))
            return reject(req, 400, `Unknown Modality code '${row.Modality}'. Read valid codes from the Modalities entity.`);
    }

    const out = [];
    for (const { row, events } of normalized) {
        const existing = row.SourceRecordId && await SELECT.one.from(ConsumptionRequests).where({ SourceRecordId: row.SourceRecordId });
        let id;
        if (existing) {
            if (row.Version <= (existing.Version || 1) && row.Action !== 'Cancel') {
                out.push(result(existing, 'Stale/duplicate RIS version ignored'));
                continue;
            }
            if (existing.Status === 'Posted') {
                await INSERT.into(ValidationEvents).entries({ Request_ID: existing.ID, Source: 'RIS', Code: 'CHANGE_AFTER_POST',
                    Message: 'Change/cancel received after posting - reverse the posted document first' });
                out.push(result(existing, 'Already posted - reversal required before change/cancel'));
                continue;
            }
            id = existing.ID;
            if (row.Action === 'Cancel') {
                await DELETE.from(E().BatchAllocations).where({ Request_ID: id });
                await UPDATE(ConsumptionRequests, id).with({ Status: 'Excluded', Version: row.Version, ErrorMessage: 'Cancelled by RIS' });
                out.push(result({ ...existing, Status: 'Excluded' }));
                continue;
            }
            const reopen = existing.Status === 'Reversed'
                ? { Status: 'Received', ErrorMessage: null, PostingVersion: existing.PostingVersion + 1,
                    SAPMaterialDocument: null, SAPMaterialDocumentYear: null, SAPMaterialDocumentItem: null, IdempotencyKey: null }
                : { Status: 'Received', ErrorMessage: null, IdempotencyKey: null };
            await UPDATE(ConsumptionRequests, id).with({ ...toCodeFields(row), ...reopen });
        } else {
            const mandatory = V.waitingRow({ ...row, Status: 'Received' });
            id = cds.utils.uuid();
            await INSERT.into(ConsumptionRequests).entries({ ID: id, ...toCodeFields(row), Status: 'Received',
                CorrelationId: row.CorrelationId || id, ExternalDocumentId: externalDocumentIdFor(row),
                ErrorMessage: V.msg(mandatory) || null });
        }
        for (const event of events) await INSERT.into(ValidationEvents).entries({ Request_ID: id, ...event });
        out.push(result(await prepareRow(id)));
    }
    return out;
}

// ---------------------------------------------------------------- reservations and batch detail
async function reservedBatchQuantities(row, batches) {
    const names = [...new Set(batches.map(batch => batch.Batch).filter(Boolean))];
    if (!names.length) return new Map();
    const allocations = await SELECT.from(E().BatchAllocations).where({ Batch: { in: names } });
    const requestIds = [...new Set(allocations.map(item => item.Request_ID).filter(id => id && id !== row.ID))];
    if (!requestIds.length) return new Map();
    const requests = await SELECT.from(E().ConsumptionRequests).where({ ID: { in: requestIds }, Status: { in: OPEN } });
    // Batch stock is shared across service dates. Keep allocations from every
    // open request at this material/plant/storage location reserved cumulatively.
    const eligible = new Set(requests.filter(request => request.Material === row.Material
        && request.Plant === row.Plant && request.StorageLocation === row.StorageLocation)
        .map(request => request.ID));
    const reserved = new Map();
    for (const allocation of allocations) {
        if (!eligible.has(allocation.Request_ID)) continue;
        const amount = Number(allocation.Quantity ?? allocation.Vials ?? 0);
        reserved.set(allocation.Batch, (reserved.get(allocation.Batch) || 0) + amount);
    }
    return reserved;
}

async function reservedMaterialQuantity(row) {
    const rows = await SELECT.from(E().ConsumptionRequests).where({ Material: row.Material,
        Plant: row.Plant, StorageLocation: row.StorageLocation, Status: { in: OPEN } });
    return rows.filter(other => other.ID !== row.ID).reduce((sum, other) => sum + Number(other.PostingQuantity || 0), 0);
}

function detailText(allocations, unit) {
    return allocations.map(item => `${item.batch}: ${calc.r(item.vials).toFixed(3)} ${unit}${item.shelfLifeExpirationDate ? ` (SLED ${item.shelfLifeExpirationDate})` : ''}`)
        .join('\n');
}

function expiryDetails(allocations) {
    return allocations
        .filter(item => item.shelfLifeExpirationDate)
        .map(item => `${item.batch}: ${String(item.shelfLifeExpirationDate).slice(0, 10)}`)
        .join('\n');
}

async function saveAllocations(requestId, picks, unit, { nuclear = false, actualMci = 0, capacity = 0 } = {}) {
    if (!picks.length) return;
    let allocatedMci = 0;
    const total = picks.reduce((sum, pick) => sum + Number(pick.vials), 0);
    const entries = picks.map((pick, index) => {
        const mci = !nuclear ? null : index === picks.length - 1
            ? calc.r(actualMci - allocatedMci)
            : calc.r(actualMci * Number(pick.vials) / total);
        if (nuclear) allocatedMci = calc.r(allocatedMci + mci);
        return {
            Request_ID: requestId,
            Sequence: index + 1,
            Batch: pick.batch,
            ShelfLifeExpirationDate: pick.shelfLifeExpirationDate || null,
            Quantity: pick.vials,
            Unit: unit,
            Vials: nuclear ? pick.vials : null,
            Mci: nuclear ? mci : null
        };
    });
    await INSERT.into(E().BatchAllocations).entries(entries);
}

function reservedMaterialIssue(available, reserved, requested) {
    const usable = calc.r(Number(available) - Number(reserved));
    return Number(requested) > usable
        ? [{ code: 'NORMAL_STOCK_SHORT', message: `Insufficient unrestricted stock after pending allocations (available ${usable})` }]
        : [];
}

// ---------------------------------------------------------------- determination + calculation + validation
async function prepareRow(id) {
    const { ConsumptionRequests, BatchAllocations } = E();
    const row = fromCodeFields(await SELECT.one.from(ConsumptionRequests).where({ ID: id }));
    if (!row || !OPEN.includes(row.Status) || isUnconfirmedPost(row)) return row;
    await DELETE.from(BatchAllocations).where({ Request_ID: id });

    let issues = [];
    let remotePostingIssues = [];
    const upd = {
        Material: null, MaterialDescription: null, MaterialClass: null, NuclearModel: null,
        MaximumMciPerVial: null, CalculatedVials: null, PostingQuantity: null, PostingUnit: null,
        Batch: null, BatchDetails: null, BatchExpiryDetails: null, BatchSource: null, EstimatedWaste: null,
        SAPProductType: null,
        Plant: null, StorageLocation: null, CostCenter: null, PostingCategory: null
    };
    let product = null;
    let readyAllocations = [];
    try {
        const det = await determine(row, cfg().prohibitedMovementTypes);
        issues.push(...V.waitingRow(row), ...det.issues);
        remotePostingIssues = getRemotePostingConfigIssues({ scenario: det.scenario });
        product = det.product;
        Object.assign(upd, {
            Material: det.material,
            MaterialDescription: product?.Description,
            MaterialClass: det.materialClass,
            SAPProductType: product?.ProductType || null,
            NuclearModel: det.nuclearModel,
            PostingScenario: det.scenario,
            Plant: det.location?.Plant,
            StorageLocation: det.location?.StorageLocation,
            CostCenter: det.location?.CostCenter,
            MaximumMciPerVial: product?.MaxMciPerVial,
            PostingCategory: det.materialClass?.startsWith('Nuclear') ? 'NMConsumption' : null
        });

        if (det.materialClass === 'Normal') {
            issues.push(...V.normalQuantity(row));
            const factor = det.unitFactor(row.EntryUnit);
            if (factor == null || !(factor > 0)) {
                issues.push({ code: 'UNIT_CONVERSION_MISSING', message: `SAP has no conversion from ${row.EntryUnit || '(blank)'} to ${product?.BaseUnit || 'the base unit'}` });
            } else if (Number(row.Quantity) > 0) {
                upd.PostingQuantity = calc.r(Number(row.Quantity) * factor);
                upd.PostingUnit = product.BaseUnit;
            }
            if (det.location && product && upd.PostingQuantity > 0) {
                const where = { material: det.material, plant: det.location.Plant, storageLocation: det.location.StorageLocation,
                    serviceDate: row.ServiceDate };
                if (product.IsBatchManagementRequired) {
                    const batches = await getS4Api().listBatchStock(where);
                    const reserved = await reservedBatchQuantities({ ...row, Material: det.material, Plant: det.location.Plant,
                        StorageLocation: det.location.StorageLocation }, batches);
                    const pick = calc.fefoSelect(batches, upd.PostingQuantity, { reservedByBatch: reserved, serviceDate: row.ServiceDate });
                    issues.push(...V.batchAllocation(pick, upd.PostingQuantity, upd.PostingUnit, 'batch-managed Normal'));
                    readyAllocations = issues.length ? [] : pick.allocations;
                    upd.BatchSource = 'FEFO';
                    upd.Batch = pick.allocations.map(item => item.batch).join(',') || null;
                    upd.BatchDetails = detailText(pick.allocations, upd.PostingUnit) || null;
                    upd.BatchExpiryDetails = expiryDetails(pick.allocations) || null;
                    if (readyAllocations.length) await saveAllocations(id, readyAllocations, upd.PostingUnit);
                } else {
                    const [available, reserved] = await Promise.all([
                        getS4Api().getMaterialStock(where), reservedMaterialQuantity({ ...row, Material: det.material,
                            Plant: det.location.Plant, StorageLocation: det.location.StorageLocation })
                    ]);
                    issues.push(...reservedMaterialIssue(available, reserved, upd.PostingQuantity));
                }
            }
        }

        if (det.materialClass?.startsWith('Nuclear')) {
            const actualMci = Number(row.ActualMci ?? row.Quantity);
            const capacity = Number(product?.MaxMciPerVial);
            upd.ActualMci = actualMci > 0 ? actualMci : row.ActualMci;
            issues.push(...V.nuclearActivity({ ...row, ActualMci: actualMci }, product?.MaxMciPerVial));
            if (!product?.BaseUnit) issues.push({ code: 'NUCLEAR_BASE_UNIT', message: 'SAP base unit is required for Nuclear posting' });
            // Read and display batch/expiry data even when posting configuration
            // (for example a missing approved movement type) still blocks POST.
            // These checks only require a resolved product, class, location,
            // activity and vial capacity.
            if (det.location && product?.BaseUnit && actualMci > 0 && capacity > 0) {
                const vials = calc.calculateLiquidVials(actualMci, capacity);
                upd.CalculatedVials = vials;
                upd.PostingQuantity = vials;
                upd.PostingUnit = 'VIL';
                const where = { material: det.material, plant: det.location.Plant, storageLocation: det.location.StorageLocation,
                    serviceDate: row.ServiceDate };
                const batches = await getS4Api().listBatchStock(where);
                const reserved = await reservedBatchQuantities({ ...row, Material: det.material, Plant: det.location.Plant,
                    StorageLocation: det.location.StorageLocation }, batches);
                const pick = det.materialClass === 'NuclearLiquid'
                    ? calc.liquidSelect(batches, row.ServiceDate, vials, { reservedByBatch: reserved })
                    : calc.fefoSelect(batches, vials, { reservedByBatch: reserved, serviceDate: row.ServiceDate });
                const kind = det.materialClass === 'NuclearLiquid' ? 'NM Liquid service-date' : 'NM Powder FEFO';
                issues.push(...V.batchAllocation(pick, vials, 'VIL', kind));
                upd.BatchSource = det.materialClass === 'NuclearLiquid' ? 'LIQUID_SERVICE_DATE' : 'FEFO';
                upd.Batch = pick.allocations.map(item => item.batch).join(',') || null;
                upd.BatchDetails = detailText(pick.allocations, 'VIL') || null;
                upd.BatchExpiryDetails = expiryDetails(pick.allocations) || null;
                readyAllocations = issues.length ? [] : pick.allocations;
                if (readyAllocations.length) await saveAllocations(id, readyAllocations, 'VIL', { nuclear: true, actualMci, capacity });
                if (det.materialClass === 'NuclearPowder') {
                    upd.EstimatedWaste = await estimatePowderWaste(row, det.material, capacity, actualMci);
                } else if (det.materialClass === 'NuclearLiquid' && readyAllocations.length) {
                    try {
                        upd.EstimatedWaste = await estimateLiquidWaste(row, det.material, det.location.Plant,
                            det.location.StorageLocation, capacity, actualMci);
                    } catch (error) {
                        // Waste is informational; a receipt-read/config issue must not block valid consumption.
                        upd.EstimatedWaste = null;
                        log.warn('NM Liquid waste estimate unavailable; consumption calculation remains valid', {
                            caseId: row.CaseId, material: det.material, plant: det.location.Plant,
                            storageLocation: det.location.StorageLocation, serviceDate: row.ServiceDate,
                            reason: error.message
                        });
                    }
                }
            }
        }
    } catch (error) {
        issues.push({ code: 'S4_LOOKUP_ERROR', message: error.message || 'S/4HANA lookup failed', technical: true });
    }

    issues.push(...remotePostingIssues);
    const hasTechnicalError = issues.some(item => item.technical);
    upd.Status = issues.length ? (hasTechnicalError ? 'Error' : 'Blocked') : 'Ready';
    upd.ErrorMessage = issues.length ? V.msg(issues).slice(0, 500) : null;
    if (upd.Status === 'Ready') {
        const allocationKey = readyAllocations.map(item => `${item.batch}:${item.vials}`).join(',');
        upd.IdempotencyKey = payload.idempotencyKey(['CASE', row.SourceRecordId, row.Version, row.PostingVersion,
            upd.Material, upd.PostingQuantity, upd.PostingUnit, allocationKey]);
    }
    await UPDATE(ConsumptionRequests, id).with(upd);
    return fromCodeFields(await SELECT.one.from(ConsumptionRequests).where({ ID: id }));
}

async function estimatePowderWaste(row, material, capacity, actualMci) {
    const rows = await SELECT.from(E().ConsumptionRequests).where({ ServiceDate: row.ServiceDate, Material: material,
        MaterialClass: 'NuclearPowder', Status: { 'not in': ['Excluded', 'Reversed'] } });
    const totalMci = rows.reduce((sum, item) => sum + Number(item.ActualMci ?? item.Quantity ?? 0), 0);
    if (!(totalMci > 0)) return null;
    const daily = calc.calculatePowderDailyWaste(totalMci, capacity);
    return calc.r(daily.wasteVials * Number(actualMci) / totalMci);
}

async function estimateLiquidWaste(row, material, plant, storageLocation, capacity, actualMci) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.ServiceDate || ''))) return null;
    const rows = await SELECT.from(E().ConsumptionRequests).where({ ServiceDate: row.ServiceDate, Material: material,
        Plant: plant, StorageLocation: storageLocation, MaterialClass: 'NuclearLiquid', Status: { 'not in': ['Excluded', 'Reversed'] } });
    const current = { ...row, Material: material, Plant: plant, StorageLocation: storageLocation,
        MaterialClass: 'NuclearLiquid', ActualMci: actualMci };
    const dailyRows = rows.some(item => item.ID === row.ID) ? rows.map(item => item.ID === row.ID ? current : item) : [...rows, current];
    const totalMci = dailyRows.reduce((sum, item) => sum + Number(item.ActualMci ?? item.Quantity ?? 0), 0);
    if (!(totalMci > 0)) return null;
    // Display an informational estimate from daily demand: assume only the
    // whole vials needed for that day's cases are opened. Actual liquid waste
    // reconciliation and posting still use S/4 receipt quantities at daily close.
    const daily = calc.calculateOpenedVialWaste(totalMci, capacity);
    return calc.r(daily.wasteVials * Number(actualMci) / totalMci);
}

async function calculateRows(ids) {
    const requestedIds = [...new Set(ids || [])];
    const requestedRows = requestedIds.length
        ? await SELECT.from(E().ConsumptionRequests).where({ ID: { in: requestedIds } })
        : [];
    const pendingRows = requestedRows.filter(row => OPEN.includes(row.Status) && !isUnconfirmedPost(row))
        // Reallocate stock in service chronology, independent of the table's display order.
        // This makes the oldest eligible SLED batches go to the earliest cases first.
        .sort((left, right) => String(left.ServiceDate || '').localeCompare(String(right.ServiceDate || ''))
            || String(left.ServiceDateTime || '').localeCompare(String(right.ServiceDateTime || ''))
            || String(left.CaseId || '').localeCompare(String(right.CaseId || ''))
            || String(left.SourceRecordId || '').localeCompare(String(right.SourceRecordId || ''))
            || String(left.ID || '').localeCompare(String(right.ID || '')));
    const pendingIds = pendingRows.map(row => row.ID);
    if (pendingIds.length) await DELETE.from(E().BatchAllocations).where({ Request_ID: { in: pendingIds } });
    const recalculated = new Map();
    for (const row of pendingRows) recalculated.set(row.ID, await prepareRow(row.ID));
    const rowsById = new Map(requestedRows.map(row => [row.ID, row]));
    return requestedIds.map(id => {
        const row = recalculated.get(id) || rowsById.get(id);
        return row ? result(row) : { ID: id, Status: 'NotFound', Message: 'Row not found' };
    });
}

// ---------------------------------------------------------------- posting
async function postSelected(ids) {
    const { ConsumptionRequests, PostingLogs, BatchAllocations } = E();
    const s4 = getS4Api();
    const out = [];
    for (const id of ids) {
        let row = await SELECT.one.from(ConsumptionRequests).where({ ID: id });
        if (!row) { out.push({ ID: id, Status: 'NotFound', Message: 'Row not found' }); continue; }
        if (row.Status === 'Posted' || row.SAPMaterialDocument) { out.push(result(row, 'Already posted - existing SAP result returned')); continue; }
        row = await prepareRow(id);
        if (row.Status !== 'Ready') { out.push(result(row)); continue; }
        if (remotePostingEnabled(row.PostingScenario)
            && (!String(row.Plant || '').trim() || !String(row.StorageLocation || '').trim())) {
            const message = 'Remote posting requires one valid Plant and Storage Location from the Hospital/Modality mapping.';
            await UPDATE(ConsumptionRequests, id).with({ Status: 'Blocked', ErrorMessage: message });
            out.push(result({ ...row, Status: 'Blocked', ErrorMessage: message }));
            continue;
        }
        const configIssues = getRemotePostingConfigIssues({ scenario: row.PostingScenario });
        if (configIssues.length) {
            const message = V.msg(configIssues).slice(0, 500);
            await UPDATE(ConsumptionRequests, id).with({ Status: 'Blocked', ErrorMessage: message });
            out.push(result({ ...row, Status: 'Blocked', ErrorMessage: message }));
            continue;
        }
        const movement = await SELECT.one.from(E().MovementTypeConfig).where({ Scenario: row.PostingScenario });
        const allocations = await SELECT.from(BatchAllocations).where({ Request_ID: id }).orderBy('Sequence');
        const lines = allocations.length
            ? allocations.map(allocation => ({ quantity: allocation.Quantity ?? allocation.Vials, unit: allocation.Unit || row.PostingUnit,
                batch: allocation.Batch, batchSource: row.BatchSource, costCenter: row.CostCenter }))
            : [{ quantity: row.PostingQuantity ?? row.Quantity, unit: row.PostingUnit || row.EntryUnit,
                costCenter: row.CostCenter }];
        const body = payload.casePrimary(row, lines, movement);
        let response;
        try {
            response = await s4.postMaterialDocument(body);
        } catch (error) {
            if (error instanceof NotConfiguredError) {
                const message = error.message.slice(0, 500);
                await UPDATE(ConsumptionRequests, id).with({ Status: 'Blocked', ErrorMessage: message });
                out.push(result({ ...row, Status: 'Blocked', ErrorMessage: message }));
                continue;
            }
            try {
                response = await s4.findResultByCaseId(row.IdempotencyKey, row.PostingScenario, row.CaseId);
            } catch (lookupError) {
                const message = `SAP posting result could not be confirmed. The case is blocked to prevent a duplicate; check the Case ID in SAP before any retry. ${lookupError.message}`;
                await UPDATE(ConsumptionRequests, id).with({ Status: 'Blocked', ErrorMessage: message.slice(0, 500) });
                await INSERT.into(PostingLogs).entries({ Request_ID: id, Scenario: row.PostingScenario,
                    IdempotencyKey: row.IdempotencyKey, Outcome: 'TechnicalError', Message: message.slice(0, 500) });
                out.push(result({ ...row, Status: 'Blocked' }, message));
                continue;
            }
            if (!response) {
                const message = 'No material document was found for this Case ID after an uncertain POST. The case is blocked; verify SAP before retrying.';
                await UPDATE(ConsumptionRequests, id).with({ Status: 'Blocked', ErrorMessage: message });
                await INSERT.into(PostingLogs).entries({ Request_ID: id, Scenario: row.PostingScenario,
                    IdempotencyKey: row.IdempotencyKey, Outcome: 'TechnicalError', Message: `${error.message}; ${message}`.slice(0, 500) });
                out.push(result({ ...row, Status: 'Blocked' }, message));
                continue;
            }
        }
        if (!response?.success) {
            const message = String(response?.Message || 'SAP rejected the goods issue').slice(0, 500);
            await UPDATE(ConsumptionRequests, id).with({ Status: 'Error', ErrorMessage: message });
            await INSERT.into(PostingLogs).entries({ Request_ID: id, Scenario: row.PostingScenario,
                IdempotencyKey: row.IdempotencyKey, Outcome: 'BusinessError', Message: message });
            out.push(result({ ...row, Status: 'Error' }, message));
            continue;
        }
        const returnedItems = response.Items || [];
        const firstItem = returnedItems[0]?.MaterialDocumentItem || null;
        await UPDATE(ConsumptionRequests, id).with({ Status: 'Posted', ErrorMessage: null,
            SAPMaterialDocument: response.MaterialDocument, SAPMaterialDocumentYear: response.MaterialDocumentYear,
            SAPMaterialDocumentItem: firstItem,
            PrimaryDocumentReference: `${response.MaterialDocument}/${response.MaterialDocumentYear}/${firstItem || ''}` });
        for (let index = 0; index < allocations.length; index++) {
            const sapItem = returnedItems[index]?.MaterialDocumentItem;
            await UPDATE(BatchAllocations, allocations[index].ID).with({ SAPMaterialDocument: response.MaterialDocument,
                SAPMaterialDocumentYear: response.MaterialDocumentYear, SAPMaterialDocumentItem: sapItem || null });
        }
        if (allocations.length) {
            const details = allocations.map((allocation, index) => {
                const quantity = calc.r(Number(allocation.Quantity ?? allocation.Vials)).toFixed(3);
                const sled = allocation.ShelfLifeExpirationDate ? ` (SLED ${allocation.ShelfLifeExpirationDate})` : '';
                const item = returnedItems[index]?.MaterialDocumentItem ? ` - SAP item ${returnedItems[index].MaterialDocumentItem}` : '';
                return `${allocation.Batch}: ${quantity} ${allocation.Unit || row.PostingUnit}${sled}${item}`;
            }).join('\n');
            await UPDATE(ConsumptionRequests, id).with({ BatchDetails: details });
        }
        await INSERT.into(PostingLogs).entries({ Request_ID: id, Scenario: row.PostingScenario,
            IdempotencyKey: row.IdempotencyKey, Outcome: 'Success', Message: response.Message,
            SAPMaterialDocument: response.MaterialDocument, SAPMaterialDocumentYear: response.MaterialDocumentYear });
        out.push(result(await SELECT.one.from(ConsumptionRequests).where({ ID: id }), response.Message));
    }
    return out;
}

// ---------------------------------------------------------------- reversal (primary)
async function reversePrimary({ ID, reason, repost }) {
    const { ConsumptionRequests, WasteAllocations, Reversals } = E();
    const row = await SELECT.one.from(ConsumptionRequests).where({ ID });
    if (!row || row.Status !== 'Posted') return { ID, Status: row?.Status, Message: 'Only posted rows can be reversed' };
    const linked = await SELECT.from(WasteAllocations).where({ Request_ID: ID, Status: 'Posted' });
    if (linked.length) return { ...result(row), Message: 'Reverse the linked NM Waste document first (reverseWaste)' };
    const response = await getS4Api().reverseMaterialDocument({ MaterialDocument: row.SAPMaterialDocument,
        MaterialDocumentYear: row.SAPMaterialDocumentYear, Reason: reason, IdempotencyKey: row.IdempotencyKey + ':REV',
        PostingScenario: row.PostingScenario });
    if (!response.success) return { ...result(row), Message: response.Message };
    await INSERT.into(Reversals).entries({ Scope: 'Primary', Request_ID: ID, OriginalDocument: row.SAPMaterialDocument,
        OriginalDocumentYear: row.SAPMaterialDocumentYear, ReversalDocument: response.MaterialDocument,
        ReversalDocumentYear: response.MaterialDocumentYear, Reason: reason });
    await UPDATE(ConsumptionRequests, ID).with({ Status: 'Reversed', PostingVersion: row.PostingVersion + 1 });
    if (repost) {
        await UPDATE(ConsumptionRequests, ID).with({ Status: 'Received', IdempotencyKey: null, SAPMaterialDocument: null,
            SAPMaterialDocumentYear: null, SAPMaterialDocumentItem: null, PrimaryDocumentReference: null });
        return result(await prepareRow(ID), 'Reversed and reopened for repost');
    }
    return result({ ...row, Status: 'Reversed' }, 'Reversed');
}

// ---------------------------------------------------------------- batch lookup helpers
const determineLiquidBatch = serviceDate => calc.liquidBatchFromServiceDate(serviceDate);
async function determinePowderBatch({ material, hospital, modality, vials }) {
    let location;
    if (remoteReadsEnabled()) {
        const matches = await slocApi.findByHospitalAndModality(hospital, modality, '1100');
        if (matches.length !== 1) return [];
        location = matches[0];
    } else {
        const matches = await SELECT.from(E().HospitalModalityMap).where({ Hospital_Code: hospital, Modality_Code: modality,
            Plant: '1100', Active: true });
        if (matches.length !== 1) return [];
        location = matches[0];
    }
    const batches = await getS4Api().listBatchStock({ material, plant: location.Plant, storageLocation: location.StorageLocation });
    const pick = calc.fefoSelect(batches, vials);
    return pick.allocations.map(item => ({ Batch: item.batch, ShelfLifeExpirationDate: item.shelfLifeExpirationDate, Vials: item.vials }));
}

module.exports = { receiveFromRis, prepareRow, calculateRows, postSelected, reversePrimary,
    determineLiquidBatch, determinePowderBatch, OPEN };
