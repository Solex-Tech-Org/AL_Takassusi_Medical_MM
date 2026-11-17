'use strict';
/** S/4HANA Product API (API_PRODUCT_SRV, OData V2). */
const cds = require('@sap/cds');

const SERVICE = 'AAML_ProductApi';
const log = cds.log('remote');
const cfg = () => {
    const credentials = cds.env.requires?.[SERVICE]?.credentials || {};
    const settings = cds.env.aaml?.productApi || {};
    return {
        destination: credentials.destination || settings.destination || 'AAML_Public_Cloud',
        language: settings.language || 'EN'
    };
};
const isConfigured = () => !!cfg().destination;
const escapeOData = value => String(value ?? '').replace(/'/g, "''");
const valueRows = data => {
    // CAP's OData V2 client unwraps d.results to a plain array before returning it.
    if (Array.isArray(data)) return data;
    const rows = data?.value ?? data?.results ?? data?.d?.results ?? data?.d ?? [];
    return Array.isArray(rows) ? rows : (rows ? [rows] : []);
};

let remote;
async function client() {
    if (!remote) remote = await cds.connect.to(SERVICE);
    return remote;
}

async function read(path) {
    const api = await client();
    const destination = cfg().destination;
    log.info('S/4 Product API request', { destination, path });
    try {
        const result = await api.send('GET', path, undefined, { accept: 'application/json' });
        const rows = valueRows(result);
        log.info('S/4 Product API response', {
            destination,
            path,
            responseShape: Array.isArray(result) ? 'array' : typeof result,
            rowCount: rows.length
        });
        return rows;
    } catch (error) {
        log.error('S/4 Product API request failed', {
            destination,
            path,
            statusCode: error.statusCode || error.status || error.response?.status,
            message: error.reason?.message || error.message || String(error)
        });
        throw error;
    }
}

const unitCode = value => String(value || '').trim().toUpperCase();
function quantityFactor(product, sourceUnit) {
    const unit = unitCode(sourceUnit);
    if (unit && unit === unitCode(product.BaseUnit)) return 1;
    const conversion = (product.UnitsOfMeasure || []).find(row => unitCode(row.AlternativeUnit) === unit);
    if (!conversion) return null;
    const numerator = Number(conversion.QuantityNumerator);
    const denominator = Number(conversion.QuantityDenominator);
    return numerator > 0 && denominator > 0 ? numerator / denominator : null;
}

function capacityMciPerVial(product) {
    const vialUnit = (product.UnitsOfMeasure || []).find(row => unitCode(row.AlternativeUnit) === 'MCi'
        || unitCode(row.AlternativeUnit) === 'MCI');
    if (!vialUnit) return null;
    const numerator = Number(vialUnit.QuantityNumerator);
    const denominator = Number(vialUnit.QuantityDenominator);
    return numerator > 0 && denominator > 0 ? denominator / numerator : null;
}

async function hydrateProduct(product) {
    const id = escapeOData(product.Product);
    const language = escapeOData(cfg().language);
    const [descriptions, storageRows, units] = await Promise.all([
        read(`/A_ProductDescription?$filter=Product eq '${id}' and Language eq '${language}'&$select=Product,Language,ProductDescription&$format=json`),
        read(`/A_ProductStorage?$filter=Product eq '${id}'&$select=Product,TotalShelfLife,ShelfLifeExpirationDatePeriod&$format=json`),
        read(`/A_ProductUnitsOfMeasure?$filter=Product eq '${id}'&$select=Product,AlternativeUnit,QuantityNumerator,QuantityDenominator&$format=json`)
    ]);
    const description = descriptions.find(row => row.Language === cfg().language) || descriptions[0];
    const storage = storageRows[0] || {};
    const hydrated = {
        Material: product.Product || '',
        ProductOldID: product.ProductOldID || '',
        ProductType: product.ProductType || '',
        Description: description?.ProductDescription || '',
        BaseUnit: product.BaseUnit || '',
        IsBatchManagementRequired: product.IsBatchManagementRequired === true || product.IsBatchManagementRequired === 'true',
        TotalShelfLife: storage.TotalShelfLife,
        ShelfLifeExpirationDatePeriod: storage.ShelfLifeExpirationDatePeriod,
        UnitsOfMeasure: units
    };
    hydrated.MaxMciPerVial = capacityMciPerVial(hydrated);
    hydrated.quantityFactor = sourceUnit => quantityFactor(hydrated, sourceUnit);
    return hydrated;
}

/** Exact RIS material lookup. The caller must reject zero or multiple matches. */
async function getProductsByOldId(risMaterialCode) {
    if (!isConfigured()) throw new Error('S/4 Product API destination is not configured');
    const code = String(risMaterialCode || '').trim();
    if (!code) return [];
    const filter = `ProductOldID eq '${escapeOData(code)}'`;
    let products;
    try {
        products = await read(`/A_Product?$filter=${encodeURIComponent(filter)}&$select=Product,ProductOldID,ProductType,BaseUnit,IsBatchManagementRequired&$format=json`);
    } catch (error) {
        throw new Error(`Product lookup through ${cfg().destination} failed: ${error.reason?.message || error.message || error}`);
    }
    return Promise.all(products.map(hydrateProduct));
}

/** Search helper retained for existing consumers; exact IDs and English descriptions are returned. */
async function searchProducts(term, { top = 25 } = {}) {
    if (!isConfigured()) throw new Error('S/4 Product API destination is not configured');
    const value = String(term || '').trim();
    if (value.length < 2) return [];
    const q = escapeOData(value);
    const filter = `(contains(Product,'${q}') or contains(ProductOldID,'${q}'))`;
    const products = await read(`/A_Product?$filter=${encodeURIComponent(filter)}&$select=Product,ProductOldID,ProductType,BaseUnit,IsBatchManagementRequired&$top=${Math.max(1, Math.min(100, Number(top) || 25))}&$format=json`);
    return Promise.all(products.map(hydrateProduct));
}

module.exports = { getProductsByOldId, searchProducts, quantityFactor, isConfigured, cfg };
