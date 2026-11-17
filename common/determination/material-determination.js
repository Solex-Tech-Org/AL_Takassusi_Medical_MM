'use strict';
const cds = require('@sap/cds');
const { SELECT } = cds.ql;
const V = require('../validation/validators');
const productApi = require('../integration/s4-product-api');
const slocApi = require('../integration/s4-sloc-api');
const { remoteReadsEnabled, remotePostingEnabled } = require('../integration/s4-config');
const log = cds.log('odata');

const SCENARIO = { Normal: 'Normal', NuclearLiquid: 'NuclearConsumption', NuclearPowder: 'NuclearConsumption' };
const issue = (code, message, technical = false) => ({ code, message, technical });
const key = value => String(value ?? '').trim().toUpperCase();

function shelfLifeDays(product) {
    const amount = Number(product.TotalShelfLife);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const unit = key(product.ShelfLifeExpirationDatePeriod);
    // SAP's ShelfLifeExpirationDatePeriod values for this tenant:
    // blank = days, 1 = weeks, 2 = months, 3 = years.
    if (['', 'D', 'DAY', 'DAYS'].includes(unit)) return amount;
    if (unit === '1') return amount * 7;
    if (unit === '2') return amount * 30;
    if (unit === '3') return amount * 365;
    if (['H', 'HR', 'HOUR', 'HOURS'].includes(unit)) return amount / 24;
    if (['W', 'WK', 'WEEK', 'WEEKS'].includes(unit)) return amount * 7;
    if (['M', 'MON', 'MONTH', 'MONTHS'].includes(unit)) return amount * 30;
    if (['Y', 'YR', 'YEAR', 'YEARS'].includes(unit)) return amount * 365;
    return null;
}

/** Product type Z005 is nuclear; shelf life selects Liquid vs Powder. */
function classify(product) {
    if (!product) return null;
    if (product.ProductType !== 'Z005') return 'Normal';
    const days = shelfLifeDays(product);
    if (days == null) return null;
    return days <= 1 ? 'NuclearLiquid' : 'NuclearPowder';
}

function nuclearModel(materialClass) {
    return materialClass === 'NuclearLiquid' ? 'LiquidDaily'
        : materialClass === 'NuclearPowder' ? 'PowderLongLife' : null;
}

async function localProduct(risMaterialCode, procedureCode) {
    const { MaterialMaster, ProcedureMaterialMap } = cds.entities('aaml.mc');
    let oldId = String(risMaterialCode || '').trim();
    if (!oldId && procedureCode) {
        oldId = (await SELECT.one.from(ProcedureMaterialMap).where({ ProcedureCode: procedureCode }))?.Material || '';
    }
    if (!oldId) return [];
    let master = await SELECT.one.from(MaterialMaster).where({ ProductOldID: oldId });
    if (!master) master = await SELECT.one.from(MaterialMaster).where({ Material: oldId });
    if (!master) return [];
    const productType = master.ProductType || (master.MaterialType === 'Nuclear' ? 'Z005' : 'Z001');
    const product = {
        Material: master.Material,
        ProductOldID: master.ProductOldID || oldId,
        ProductType: productType,
        Description: master.Description,
        BaseUnit: master.BaseUnit,
        IsBatchManagementRequired: Boolean(master.IsBatchManagementRequired),
        TotalShelfLife: master.TotalShelfLife ?? (master.NuclearModel === 'LiquidDaily' ? 1 : master.NuclearModel === 'PowderLongLife' ? 365 : 0),
        ShelfLifeExpirationDatePeriod: master.ShelfLifeExpirationDatePeriod || 'D',
        MaxMciPerVial: master.MaxMciPerVial,
        quantityFactor: unit => key(unit) === key(master.BaseUnit) ? 1 : null
    };
    return [product];
}

async function localLocations(row, plant) {
    const { HospitalModalityMap } = cds.entities('aaml.mc');
    const mappings = await SELECT.from(HospitalModalityMap).where({
        Hospital_Code: row.Hospital,
        Modality_Code: row.Modality,
        Plant: plant,
        Active: true
    });
    return mappings.map(mapping => ({ ...mapping, Plant: plant }));
}

async function locationFor(row) {
    const plant = String(cds.env.aaml?.s4?.plant || '1100');
    if (!row.Hospital || !row.Modality) return [];
    if (remoteReadsEnabled()) {
        const mappingPath = String(cds.env.aaml?.s4?.slocMappingPath || '').trim();
        if (!mappingPath) {
            const mappings = await localLocations(row, plant);
            log.warn('S/4 SLoc mapping API is not configured; using the existing local mapping temporarily', {
                hospital: row.Hospital, modality: row.Modality, plant, matchCount: mappings.length
            });
            return mappings;
        }
        try {
            return await slocApi.findByHospitalAndModality(row.Hospital, row.Modality, plant);
        } catch (error) {
            const notConfigured = error instanceof slocApi.NotConfiguredError;
            return { error: issue(notConfigured ? 'SLOC_API_NOT_CONFIGURED' : 'SLOC_API_ERROR',
                `Storage-location mapping lookup failed: ${error.message}`, !notConfigured) };
        }
    }
    return localLocations(row, plant);
}

/** Resolve SAP product, derived class, exact hospital/modality SLoc and movement rule. */
async function determine(row, prohibited) {
    const { MovementTypeConfig } = cds.entities('aaml.mc');
    const code = String(row.RISMaterialCode || '').trim();
    const issues = [];
    let products = [];
    const useRemoteReads = remoteReadsEnabled();
    log.info('Case material lookup started', {
        readMode: useRemoteReads ? 'remote' : 'mock',
        hasRisMaterialCode: Boolean(code)
    });
    try {
        products = useRemoteReads
            ? await productApi.getProductsByOldId(code)
            : await localProduct(code, row.ProcedureCode);
        log.info('Case material lookup completed', {
            readMode: useRemoteReads ? 'remote' : 'mock',
            matchCount: products.length
        });
    } catch (error) {
        log.error('Case material lookup failed', { message: error.message });
        issues.push(issue('PRODUCT_API_ERROR', `Product lookup failed: ${error.message}`, true));
    }
    if (!code) issues.push(issue('RIS_MATERIAL_REQUIRED', 'RIS Material Code is required to identify the SAP product'));
    if (code && products.length === 0 && !issues.some(item => item.technical))
        issues.push(issue('PRODUCT_NOT_FOUND', `No SAP product has ProductOldID '${code}'`));
    if (products.length > 1)
        issues.push(issue('PRODUCT_NOT_UNIQUE', `ProductOldID '${code}' matched ${products.length} SAP products`));

    const product = products.length === 1 ? products[0] : null;
    const materialClass = classify(product);
    if (product && !materialClass) issues.push(...V.classification(product, materialClass));

    const locationResult = await locationFor(row);
    const maps = Array.isArray(locationResult) ? locationResult : [];
    if (!Array.isArray(locationResult) && locationResult?.error) issues.push(locationResult.error);
    issues.push(...V.location(maps));
    const location = maps.length === 1 ? maps[0] : null;

    const scenario = SCENARIO[materialClass] || null;
    const movement = scenario ? await SELECT.one.from(MovementTypeConfig).where({ Scenario: scenario }) : null;
    if (scenario) {
        issues.push(...V.movementType(movement, prohibited));
        if (remotePostingEnabled(scenario) && /^DEMO/i.test(String(movement?.GoodsMovementType || '')))
            issues.push(issue('MOVEMENT_TYPE_PLACEHOLDER', 'Configure the SAP-approved goods-movement type before remote posting'));
    }

    const unitFactor = unit => product?.quantityFactor?.(unit) ?? null;
    return {
        material: product?.Material || null,
        product,
        master: product,
        materialClass,
        nuclearModel: nuclearModel(materialClass),
        scenario,
        location,
        movement,
        unitFactor,
        issues
    };
}

module.exports = { classify, shelfLifeDays, determine, SCENARIO };
