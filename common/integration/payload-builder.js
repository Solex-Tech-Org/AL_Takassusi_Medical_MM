'use strict';
/** Builds the canonical business payload from FSD 6.3 before the SAP adapter maps it. */
const crypto = require('crypto');
const idempotencyKey = parts => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);

const baseHeader = h => ({
    MaterialDocumentHeaderText: h.text,            // never contains patient name
    ExternalDocumentId: h.externalId, IdempotencyKey: h.key, CorrelationId: h.correlationId,
    PostingScenario: h.scenario, PostingCategory: h.category,
    PostingDate: h.postingDate, DocumentDate: h.documentDate, ServiceDate: h.serviceDate,
    GoodsMovementCode: h.goodsMovementCode
});

function casePrimary(row, lines, mv) {
    const nuclear = row.PostingScenario === 'NuclearConsumption';
    return {
        ...baseHeader({
            text: `AAML ${row.PostingScenario} ${row.CaseId}`, externalId: row.ExternalDocumentId, key: row.IdempotencyKey,
            correlationId: row.CorrelationId, scenario: row.PostingScenario, category: nuclear ? 'NMConsumption' : undefined,
            postingDate: row.ServiceDate, documentDate: row.ServiceDate, serviceDate: row.ServiceDate, goodsMovementCode: mv.GoodsMovementCode
        }),
        CaseId: row.CaseId, Hospital: row.Hospital, Modality: row.Modality,
        ...(nuclear && { ActualMci: row.ActualMci, MaximumMciPerVial: row.MaximumMciPerVial, NMConsumptionModel: row.NuclearModel }),
        Items: lines.map((l, i) => ({
            MaterialDocumentLine: i + 1, GoodsMovementType: mv.GoodsMovementType, Material: row.Material,
            Plant: row.Plant, StorageLocation: row.StorageLocation, Quantity: l.quantity, EntryUnit: l.unit, Batch: l.batch, BatchSource: l.batchSource,
            CaseId: row.CaseId, Hospital: row.Hospital, Modality: row.Modality
        }))
    };
}

/** One primary consumption document containing every selected case line for a service day. */
function dailyPrimary(serviceDate, items, key, scenario = 'NuclearConsumption') {
    return {
        ...baseHeader({
            text: `${scenario === 'NuclearConsumption' ? 'AAML NM Consumption' : 'AAML Consumption'} ${serviceDate}`,
            externalId: `AAML-CONSUMPTION-${serviceDate}`, key,
            correlationId: serviceDate, scenario, category: scenario === 'NuclearConsumption' ? 'NMConsumption' : undefined,
            postingDate: serviceDate, documentDate: serviceDate, serviceDate, goodsMovementCode: '03'
        }),
        DailyGroupKey: serviceDate,
        Items: items.map((item, i) => ({ MaterialDocumentLine: (i + 1) * 10, ...item }))
    };
}

function wastePosting(close, allocs, mv, key, postingDate) {
    return {
        ...baseHeader({
            text: `AAML NM Waste ${close.ServiceDate}`, externalId: `AAML-WASTE-${close.ServiceDate}-v${close.Version}`, key,
            correlationId: close.ID, scenario: 'NuclearWaste', category: 'NMWaste', postingDate, documentDate: postingDate,
            serviceDate: close.ServiceDate, goodsMovementCode: mv.GoodsMovementCode
        }),
        DailyCloseId: close.ID, DailyGroupKey: close.DailyGroupKey,
        Items: allocs.map((a, i) => ({
            MaterialDocumentLine: i + 1, GoodsMovementType: mv.GoodsMovementType, Material: a.Material,
            Plant: a.Plant, StorageLocation: a.StorageLocation, Quantity: a.WasteVials, EntryUnit: 'VIL', Batch: a.Batch,
            CaseId: a.CaseId, Hospital: a.Hospital, Modality: a.Modality,
            PrimaryDocumentReference: a.PrimaryDocumentReference, AllocationShare: a.AllocationShare
        }))
    };
}

function shared(h, items, mv, key) {
    return {
        ...baseHeader({
            text: `AAML Nursing ${h.Hospital}/${h.Modality}`, externalId: h.ExternalDocumentId, key, correlationId: h.CorrelationId,
            scenario: 'NursingShared', postingDate: h.PostingDate, documentDate: h.PostingDate, serviceDate: h.PostingDate, goodsMovementCode: mv.GoodsMovementCode
        }),
        Hospital: h.Hospital, Modality: h.Modality,
        Items: items.map((it, i) => ({
            MaterialDocumentLine: i + 1, GoodsMovementType: mv.GoodsMovementType, Material: it.Material,
            Plant: h.Plant, StorageLocation: h.StorageLocation, Quantity: it.Quantity, EntryUnit: it.BUOM
        }))
    };
}
module.exports = { idempotencyKey, casePrimary, dailyPrimary, wastePosting, shared };
