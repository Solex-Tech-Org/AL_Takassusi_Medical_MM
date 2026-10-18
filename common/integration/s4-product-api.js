'use strict';
/**
 * SAP S/4HANA Cloud Product API (OData V4 API_PRODUCT / product/0002).
 * Credentials and base URL come from env (or cds.env.aaml.productApi).
 *
 *  Material    <- Product          (MARA-MATNR)
 *  Description <- ProductDescription (MAKT-MAKTX)
 *  BUOM        <- BaseUnit         (MARA-MEINS)
 */
const cds = require('@sap/cds');
const path = require('path');

// Load .env from project root (works even when CAP cwd differs)
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const cfg = () => {
  const e = cds.env.aaml?.productApi || {};
  return {
    baseUrl: (process.env.S4_PRODUCT_API_BASE_URL || e.baseUrl || '').replace(/\/+$/, '').replace(/\/Product$/i, ''),
    username: process.env.API_USERNAME || process.env.S4_PRODUCT_API_USERNAME || e.username || '',
    password: process.env.API_PASSWORD || process.env.S4_PRODUCT_API_PASSWORD || e.password || '',
    language: process.env.S4_PRODUCT_API_LANGUAGE || e.language || 'EN'
  };
};

const isConfigured = () => {
  const c = cfg();
  return !!(c.baseUrl && c.username && c.password);
};

const escapeOData = s => String(s).replace(/'/g, "''");

async function httpGet(url, { username, password }) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Product API ${res.status}: ${body.slice(0, 300) || res.statusText}`);
  }
  return res.json();
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
  if (!isConfigured()) throw new Error('S4 Product API is not configured (S4_PRODUCT_API_BASE_URL / API_USERNAME / API_PASSWORD)');
  const t = String(term || '').trim();
  if (t.length < 2) return [];

  const { baseUrl, username, password, language } = cfg();
  const q = escapeOData(t);
  const expand = `_ProductDescription($filter=Language eq '${escapeOData(language)}';$select=Product,Language,ProductDescription)`;
  // Match Product ID or description — no tolower (not supported by this API)
  const filter =
    `(contains(Product,'${q}')` +
    ` or _ProductDescription/any(d:contains(d/ProductDescription,'${q}')))`;
  const url =
    `${baseUrl}/Product?$select=Product,BaseUnit` +
    `&$expand=${encodeURIComponent(expand)}` +
    `&$filter=${encodeURIComponent(filter)}` +
    `&$top=${top}`;

  const data = await httpGet(url, { username, password });
  const rows = data.value || data.d?.results || data.d || [];
  const list = Array.isArray(rows) ? rows : [];
  return list.map(r => mapProduct(r, language)).filter(r => r.Material);
}

module.exports = { searchProducts, isConfigured, cfg };
