'use strict';
/**
 * SAP S/4HANA Cloud Product API (OData V4 API_PRODUCT / product/0002).
 * Host and BasicAuthentication (user / password) come from BTP destination
 * AAML_Public_Cloud. The OData service path is appended to that destination URL.
 *
 *  Material    <- Product          (MARA-MATNR)
 *  Description <- ProductDescription (MAKT-MAKTX)
 *  BUOM        <- BaseUnit         (MARA-MEINS)
 */
const cds = require('@sap/cds');

const SERVICE = 'AAML_ProductApi';

const cfg = () => {
  const creds = cds.env.requires?.[SERVICE]?.credentials || {};
  const e = cds.env.aaml?.productApi || {};
  return {
    destination: creds.destination || e.destination || 'AAML_Public_Cloud',
    language: e.language || 'EN'
  };
};

const isConfigured = () => !!cfg().destination;

const escapeOData = s => String(s).replace(/'/g, "''");

let remote;
async function client() {
  if (!remote) remote = await cds.connect.to(SERVICE);
  return remote;
}

function mapProduct(row, language) {
  const descs = row._ProductDescription || row.ProductDescription || [];
  const list = Array.isArray(descs) ? descs : (descs ? [descs] : []);
  const preferred = list.find(d => d.Language === language) || list[0];
  return {
    Material: row.Product || row.ProductId || '',
    Description: preferred?.ProductDescription || preferred?.Description || '',
    BUOM: row.BaseUnit || ''
  };
}

/**
 * Search products by material code or description (min 2 chars).
 * Note: S/4 API_PRODUCT does not support tolower() in $filter.
 * @returns {Promise<Array<{Material,Description,BUOM}>>}
 */
async function searchProducts(term, { top = 25 } = {}) {
  if (!isConfigured()) throw new Error('S4 Product API destination is not configured');
  const t = String(term || '').trim();
  if (t.length < 2) return [];

  const { destination, language } = cfg();
  const q = escapeOData(t);
  const expand = `_ProductDescription($filter=Language eq '${escapeOData(language)}';$select=Product,Language,ProductDescription)`;
  // Match Product ID or description — no tolower (not supported by this API)
  const filter =
    `(contains(Product,'${q}')` +
    ` or _ProductDescription/any(d:contains(d/ProductDescription,'${q}')))`;
  const path =
    `/Product?$select=Product,BaseUnit` +
    `&$expand=${encodeURIComponent(expand)}` +
    `&$filter=${encodeURIComponent(filter)}` +
    `&$top=${top}`;

  const api = await client();
  let data;
  try {
    data = await api.send({ method: 'GET', path, headers: { accept: 'application/json' } });
  } catch (e) {
    const detail = e.reason?.message || e.message || String(e);
    throw new Error(`Product API via BTP destination ${destination} failed: ${detail}`);
  }
  const rows = data?.value || data?.d?.results || data?.d || [];
  const list = Array.isArray(rows) ? rows : [];
  return list.map(r => mapProduct(r, language)).filter(r => r.Material);
}

module.exports = { searchProducts, isConfigured, cfg };
