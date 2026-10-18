'use strict';
/**
 * Builds the business payload of FSD 6.3 (Z Material API).
 * !! Field names are the FSD "required API field" names - CONFIRM against the
 * !! Z API extension fields before configuration/testing (FSD note, 6.3).
 */
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
            Plant: row.Plant, StorageLocation: row.StorageLocation, Quantity: l.quantity, EntryUnit: l.unit, Batch: l.batch, BatchSource: l.batchSource
        }))
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
            Plant: a.Plant, StorageLocation: a.StorageLocation, Quantity: a.WasteVials, EntryUnit: 'Vial', Batch: a.Batch,
            CaseId: a.CaseId, Hospital: a.Hospital, Modality: a.Modality, NMConsumptionModel: a.NuclearModel,
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
        Hospital: h.Hospital, Modality: h.Modality, CostCenter: h.CostCenter,
        Items: items.map((it, i) => ({
            MaterialDocumentLine: i + 1, GoodsMovementType: mv.GoodsMovementType, Material: it.Material,
            Plant: h.Plant, StorageLocation: h.StorageLocation, Quantity: it.Quantity, EntryUnit: it.BUOM
        }))
    };
}
module.exports = { idempotencyKey, casePrimary, wastePosting, shared };
