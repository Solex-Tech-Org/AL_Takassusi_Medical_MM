'use strict';
/** Validation rules (FSD 7.1). Each returns an array of { code, message } (empty = accepted). */
const issue = (code, message) => ({ code, message });

const waitingRow = row => {
    const out = [];
    if (['Posted', 'Reversed'].includes(row.Status)) out.push(issue('ALREADY_POSTED', 'Row is already posted/reversed'));
    for (const f of ['CaseId', 'SourceRecordId', 'ServiceDate', 'Hospital', 'Modality'])
        if (!row[f]) out.push(issue('MISSING_' + f.toUpperCase(), `Required source field ${f} is missing`));
    return out;
};
const classification = (master, materialClass) => {
    if (!master) return [issue('MATERIAL_UNKNOWN', 'Material not found in material data')];
    if (!materialClass) return [issue('CLASSIFICATION_INVALID', 'Material Type / Nuclear Consumption Model incomplete or invalid for case consumption')];
    return [];
};
const normalQuantity = row =>
    !(Number(row.Quantity) > 0) ? [issue('QTY_INVALID', 'Quantity must be > 0')]
        : !row.EntryUnit ? [issue('UNIT_INVALID', 'Entry Unit is required')] : [];
const nuclearActivity = (row, max) => {
    const out = [];
    if (!(Number(row.ActualMci) > 0)) out.push(issue('MCI_INVALID', 'Actual mCi must be > 0'));
    if (!(Number(max) > 0)) out.push(issue('CAPACITY_INVALID', 'Maximum mCi per Vial must be > 0'));
    return out;
};
const liquidBatch = (stock, vials, batch) =>
    !stock ? [issue('LIQUID_BATCH_MISSING', `Exact service-date batch ${batch} does not exist; no other date batch may be used`)]
        : Number(stock.UnrestrictedQty) < vials ? [issue('LIQUID_BATCH_SHORT', `Batch ${batch} has insufficient stock`)] : [];
const powderBatch = pick =>
    pick.allocations.length === 0 ? [issue('POWDER_NO_STOCK', 'No eligible unrestricted Powder batch')]
        : pick.shortfall > 0 ? [issue('POWDER_STOCK_SHORT', `Insufficient Powder stock across FEFO batches (short ${pick.shortfall} Vial)`)] : [];
const movementType = (cfg, prohibited = ['Z01']) =>
    !cfg || !cfg.Active || !cfg.GoodsMovementType ? [issue('MOVEMENT_TYPE_MISSING', 'Approved custom goods-issue movement type is not configured')]
        : prohibited.includes(cfg.GoodsMovementType) ? [issue('MOVEMENT_TYPE_PROHIBITED', `Movement type ${cfg.GoodsMovementType} is prohibited (not a goods-issue type)`)] : [];
const location = maps =>
    maps.length !== 1 ? [issue('LOCATION_MAPPING', `Hospital + Modality must map to exactly one active entry (found ${maps.length})`)] : [];
const costCenter = maps =>
    maps.length !== 1 || !maps[0].CostCenter ? [issue('COST_CENTER', 'Hospital + Modality must return exactly one active cost center')] : [];
const sharedMaterial = master =>
    !master || !master.Active || master.MaterialType !== 'Nursing'
        ? [issue('NOT_NURSING_MATERIAL', 'Material is not an active approved Nursing material')] : [];
const sharedItem = (item, master) => {
    const out = sharedMaterial(master);
    if (!(Number(item.Quantity) > 0)) out.push(issue('QTY_INVALID', 'Quantity must be > 0'));
    if (master && item.BUOM && item.BUOM !== master.BaseUnit) out.push(issue('BUOM_MISMATCH', `Quantity must be entered in BUOM ${master.BaseUnit}`));
    return out;
};
const msg = list => list.map(i => i.message).join('; ');

module.exports = {
    waitingRow, classification, normalQuantity, nuclearActivity, liquidBatch, powderBatch,
    movementType, location, costCenter, sharedMaterial, sharedItem, msg
};
