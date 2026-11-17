'use strict';
/** S/4HANA batch, stock and goods-issue API boundary. */
const cds = require('@sap/cds');
const { SELECT } = cds.ql;
const { remoteReadsEnabled, remotePostingEnabled } = require('./s4-config');

const SERVICES = {
    batch: 'AAML_BatchApi',
    stock: 'AAML_MaterialStockApi',
    document: 'AAML_MaterialDocumentApi',
    posting: 'AAML_MaterialPostingApi'
};
class NotConfiguredError extends Error { }
const cfg = () => cds.env.aaml?.s4 || {};
const validFieldName = value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value || '').trim());
const escapeOData = value => String(value ?? '').replace(/'/g, "''");
const rowsOf = data => {
    // CAP's OData V2 client unwraps d.results to a plain array before returning it.
    if (Array.isArray(data)) return data;
    const rows = data?.value ?? data?.results ?? data?.d?.results ?? data?.d ?? [];
    return Array.isArray(rows) ? rows : (rows ? [rows] : []);
};
const resultOf = data => data?.d ?? data?.value ?? data ?? {};
const bool = value => value === true || value === 'true' || value === 'X' || value === 'x' || value === 1 || value === '1';
const dateOnly = value => {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const raw = String(value);
    const sapDate = /\/Date\((\d+)/.exec(raw);
    if (sapDate) return new Date(Number(sapDate[1])).toISOString().slice(0, 10);
    return raw.slice(0, 10);
};

/** Required tenant-specific posting configuration. */
function getRemotePostingConfigIssues({ scenario } = {}) {
    const config = cfg();
    if (!remotePostingEnabled(scenario)) return [];
    if (scenario === null) return [];
    const issues = [];
    const postPath = String(config.goodsIssuePostPath || '').trim();
    if (!postPath.startsWith('/') || postPath === '/') issues.push({ code: 'GI_PATH_NOT_CONFIGURED', message: 'Configure the SAP goods-issue post path beginning with /' });

    const lookupPath = String(config.goodsIssueCaseLookupPath || '').trim();
    if (!lookupPath.startsWith('/') || lookupPath === '/') {
        issues.push({ code: 'CASE_LOOKUP_PATH_NOT_CONFIGURED', message: 'Configure the S/4 material-document lookup path used to confirm a case posting' });
    }
    if (!validFieldName(config.goodsIssueCaseLookupField)) {
        issues.push({ code: 'CASE_LOOKUP_FIELD_NOT_CONFIGURED', message: 'Configure the S/4 field used to find a material document by Case ID' });
    }
    return issues;
}

async function remoteRows(serviceName, path) {
    const api = await cds.connect.to(serviceName);
    const response = await api.send('GET', path, undefined, { accept: 'application/json' });
    return rowsOf(response);
}

function unrestricted(rows) {
    return rows.filter(row => String(row.InventoryStockType || '01') === '01'
        && !String(row.InventorySpecialStockType || '').trim());
}

function eligibleBatch(batch, plantBatch, stock, serviceDate) {
    const date = dateOnly(serviceDate) || new Date().toISOString().slice(0, 10);
    const availability = dateOnly(batch.MatlBatchAvailabilityDate || plantBatch?.MatlBatchAvailabilityDate);
    const sled = dateOnly(batch.ShelfLifeExpirationDate || plantBatch?.ShelfLifeExpirationDate || stock.ShelfLifeExpirationDate);
    const restricted = bool(batch.MatlBatchIsInRstrcdUseStock || plantBatch?.MatlBatchIsInRstrcdUseStock);
    const deleted = bool(batch.BatchIsMarkedForDeletion || plantBatch?.BatchIsMarkedForDeletion);
    return {
        eligible: !restricted && !deleted && (!availability || availability <= date) && (!sled || sled >= date),
        shelfLifeExpirationDate: sled || null,
        availabilityDate: availability || null,
        MatlBatchIsInRstrcdUseStock: restricted,
        BatchIsMarkedForDeletion: deleted
    };
}

class RemoteS4MaterialApi {
    async _stockRows({ material, plant, storageLocation }) {
        const filter = [
            `Material eq '${escapeOData(material)}'`,
            `Plant eq '${escapeOData(plant)}'`,
            `StorageLocation eq '${escapeOData(storageLocation)}'`,
            "InventoryStockType eq '01'"
        ].join(' and ');
        const rows = await remoteRows(SERVICES.stock,
            `/A_MatlStkInAcctMod?$filter=${encodeURIComponent(filter)}&$select=Material,Plant,StorageLocation,Batch,InventoryStockType,InventorySpecialStockType,MatlWrhsStkQtyInMatlBaseUnit&$format=json`);
        return unrestricted(rows);
    }

    async _listBatchStock({ material, plant, storageLocation, serviceDate }, includeZero = false) {
        const batchFilter = `Material eq '${escapeOData(material)}'`;
        const plantFilter = `Material eq '${escapeOData(material)}' and Plant eq '${escapeOData(plant)}'`;
        const [batchRows, plantRows, stockRows] = await Promise.all([
            remoteRows(SERVICES.batch,
                `/Batch?$filter=${encodeURIComponent(batchFilter)}&$select=Material,Batch,ShelfLifeExpirationDate,MatlBatchAvailabilityDate,MatlBatchIsInRstrcdUseStock,BatchIsMarkedForDeletion&$format=json`),
            remoteRows(SERVICES.batch,
                `/BatchPlant?$filter=${encodeURIComponent(plantFilter)}&$select=Material,Batch,Plant&$format=json`),
            this._stockRows({ material, plant, storageLocation })
        ]);
        const batches = new Map(batchRows.map(row => [String(row.Batch), row]));
        const plantBatches = new Map(plantRows.map(row => [String(row.Batch), row]));
        const totals = new Map();
        for (const stock of stockRows) {
            if (!stock.Batch) continue;
            const name = String(stock.Batch);
            totals.set(name, (totals.get(name) || 0) + Number(stock.MatlWrhsStkQtyInMatlBaseUnit || 0));
        }
        const result = [];
        for (const [batchName, batch] of batches) {
            const plantBatch = plantBatches.get(batchName);
            if (!plantBatch) continue;
            const quantity = totals.get(batchName) || 0;
            const flags = eligibleBatch(batch, plantBatch, {}, serviceDate);
            if (!flags.eligible || (!includeZero && !(quantity > 0))) continue;
            result.push({
                Batch: batchName,
                UnrestrictedQty: quantity,
                ReceivedQty: null,
                ShelfLifeExpirationDate: flags.shelfLifeExpirationDate,
                BatchAvailabilityDate: flags.availabilityDate,
                MatlBatchIsInRstrcdUseStock: flags.MatlBatchIsInRstrcdUseStock,
                BatchIsMarkedForDeletion: flags.BatchIsMarkedForDeletion,
                Plant: plant
            });
        }
        return result;
    }

    async getBatchStock(args) {
        const rows = await this._listBatchStock(args, true);
        const batch = rows.find(row => row.Batch === args.batch) || null;
        if (batch) batch.ReceivedQty = await this._dailyReceivedQuantity(args);
        return batch;
    }

    async _dailyReceivedQuantity({ material, plant, storageLocation, batch, serviceDate }) {
        const config = cfg();
        const movementTypes = Array.isArray(config.goodsReceiptMovementTypes)
            ? config.goodsReceiptMovementTypes.map(type => String(type).trim()).filter(Boolean) : [];
        if (!movementTypes.length) return null;
        const path = String(config.goodsReceiptItemsPath || '/A_MaterialDocumentItem').trim();
        const quantityField = String(config.goodsReceiptQuantityField || 'QuantityInBaseUnit').trim();
        const dateField = String(config.goodsReceiptPostingDateField || 'PostingDate').trim();
        const date = dateOnly(serviceDate);
        if (!path.startsWith('/') || path === '/' || !validFieldName(quantityField) || !validFieldName(dateField)
            || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        const filters = [
            `Material eq '${escapeOData(material)}'`,
            `Plant eq '${escapeOData(plant)}'`,
            `StorageLocation eq '${escapeOData(storageLocation)}'`,
            `Batch eq '${escapeOData(batch)}'`,
            "InventoryStockType eq '01'",
            "InventorySpecialStockType eq ''",
            `${dateField} eq datetime'${date}T00:00:00'`,
            `(${movementTypes.map(type => `GoodsMovementType eq '${escapeOData(type)}'`).join(' or ')})`
        ].join(' and ');
        const items = await remoteRows(SERVICES.document,
            `${path}?$filter=${encodeURIComponent(filters)}&$select=Material,Plant,StorageLocation,Batch,GoodsMovementType,${dateField},${quantityField},IsReversalMovementType&$format=json`);
        return items.reduce((sum, item) => bool(item.IsReversalMovementType)
            ? sum : sum + Math.max(0, Number(item[quantityField] || 0)), 0);
    }

    async listBatchStock(args) {
        return this._listBatchStock(args, false);
    }

    async getMaterialStock(args) {
        const rows = await this._stockRows(args);
        return rows.reduce((sum, row) => sum + Number(row.MatlWrhsStkQtyInMatlBaseUnit || 0), 0);
    }

    _documentPath() {
        const path = String(cfg().goodsIssuePostPath || '').trim();
        if (!path.startsWith('/') || path === '/') throw new NotConfiguredError('Configure a goods-issue post path beginning with /');
        return path;
    }

    _documentBody(payload) {
        return {
            MaterialDocumentHeaderText: String(payload.MaterialDocumentHeaderText || '').slice(0, 25),
            PostingDate: dateOnly(payload.PostingDate),
            DocumentDate: dateOnly(payload.DocumentDate),
            GoodsMovementCode: '03',
            Items: (payload.Items || []).map((item, index) => {
                const row = {
                    MaterialDocumentLine: String((index + 1) * 10).padStart(6, '0'),
                    Material: item.Material,
                    Plant: item.Plant,
                    StorageLocation: item.StorageLocation,
                    GoodsMovementType: item.GoodsMovementType,
                    Quantity: Number(item.Quantity),
                    EntryUnit: item.EntryUnit
                };
                if (item.Batch) row.Batch = item.Batch;
                const costCenter = item.CostCenter || payload.CostCenter;
                if (costCenter) row.CostCenter = costCenter;
                const caseId = item.CaseId ?? payload.CaseId;
                const hospital = item.Hospital ?? payload.Hospital;
                const modality = item.Modality ?? payload.Modality;
                if (caseId) row.CaseId = caseId;
                if (hospital) row.Hospital = hospital;
                if (modality) row.Modality = modality;
                return row;
            })
        };
    }

    async postMaterialDocument(payload) {
        const configIssues = getRemotePostingConfigIssues({ scenario: payload.PostingScenario });
        if (configIssues.length) throw new NotConfiguredError(configIssues.map(issue => issue.message).join('; '));
        const path = this._documentPath();
        const data = this._documentBody(payload);
        const api = await cds.connect.to(SERVICES.posting);
        let response;
        try {
            response = await api.send('POST', path, data, {
                accept: 'application/json',
                'content-type': 'application/json',
                'idempotency-key': payload.IdempotencyKey,
                'x-external-document-id': payload.ExternalDocumentId
            });
        } catch (error) {
            const status = Number(error.statusCode || error.status || error.response?.status || error.reason?.response?.status);
            const responseBody = error.response?.body || error.response?.data || error.reason?.response?.body || error.reason?.response?.data;
            let sapError = responseBody;
            if (Buffer.isBuffer(sapError)) sapError = sapError.toString('utf8');
            if (typeof sapError === 'string') {
                try { sapError = JSON.parse(sapError); } catch { /* Keep the original transport error below. */ }
            }
            const sapMessage = [
                sapError?.Message,
                sapError?.message?.value,
                typeof sapError?.message === 'string' ? sapError.message : null,
                sapError?.error?.message?.value,
                typeof sapError?.error?.message === 'string' ? sapError.error.message : null
            ].find(message => typeof message === 'string' && message.trim());
            // A received client-error response is a definite rejection. Network failures,
            // timeouts and server errors remain uncertain and are handled by the lookup guard.
            if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
                return { success: false, Message: String(sapMessage || error.message || `S/4 rejected the request (HTTP ${status})`) };
            }
            throw error;
        }
        const header = resultOf(response);
        const status = String(header.Status || '').trim().toUpperCase();
        const document = header.MaterialDocument;
        const year = header.MaterialDocumentYear;
        const result = {
            success: status === 'SUCCESS' && !!(document && year),
            MaterialDocument: document,
            MaterialDocumentYear: year,
            // The custom API returns document/year only; it doesn't return SAP item numbers.
            Items: [],
            Message: header.Message || (status === 'SUCCESS' ? 'SAP did not return a material document number/year' : 'SAP rejected the goods issue')
        };
        if (result.success && payload.CaseId) {
            try {
                const existing = await this._findResultByCaseId(payload.CaseId);
                if (existing?.MaterialDocument === document && existing?.MaterialDocumentYear === year) {
                    result.Items = existing.Items;
                }
            } catch {
                // The posting API's success response is authoritative; item-number lookup is best effort.
            }
        }
        return result;
    }

    async _findResultByCaseId(caseId) {
        const config = cfg();
        const path = String(config.goodsIssueCaseLookupPath || '').trim();
        const field = String(config.goodsIssueCaseLookupField || '').trim();
        if (!caseId) throw new NotConfiguredError('RIS Case ID is required to look up a possibly posted S/4 material document');
        if (!path || !field) throw new NotConfiguredError('S/4 material-document result lookup is not configured; confirm SAP before retrying');
        if (!path.startsWith('/') || !validFieldName(field)) throw new NotConfiguredError('S/4 material-document result lookup path or field is invalid');
        const filter = `${field} eq '${escapeOData(caseId)}'`;
        const separator = path.includes('?') ? '&' : '?';
        const select = ['MaterialDocumentYear', 'MaterialDocument', 'MaterialDocumentItem', 'MaterialDocumentLine',
            'GoodsMovementIsCancelled', 'ReversedMaterialDocument', field].join(',');
        const rows = await remoteRows(SERVICES.document,
            `${path}${separator}$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent(select)}&$format=json`);
        const activeRows = rows.filter(row => !bool(row.GoodsMovementIsCancelled)
            && !/^0+$/.test(String(row.ReversedMaterialDocument || '').trim()));
        const documents = new Map();
        for (const row of activeRows) {
            const docKey = `${row.MaterialDocumentYear}/${row.MaterialDocument}`;
            if (!row.MaterialDocument || !row.MaterialDocumentYear) continue;
            if (!documents.has(docKey)) documents.set(docKey, []);
            documents.get(docKey).push(row);
        }
        if (documents.size > 1) {
            throw new NotConfiguredError(`More than one active SAP material document matches Case ID '${caseId}'; verify the case in SAP before retrying`);
        }
        const [docKey, items] = documents.entries().next().value || [];
        if (!docKey) return null;
        items.sort((left, right) => Number(left.MaterialDocumentLine || 0) - Number(right.MaterialDocumentLine || 0));
        const [year, document] = docKey.split('/');
        return {
            success: true,
            MaterialDocument: document,
            MaterialDocumentYear: year,
            Items: items.map(item => ({
                MaterialDocumentLine: String(Number(item.MaterialDocumentLine || 0)).padStart(6, '0'),
                MaterialDocumentItem: item.MaterialDocumentItem
            })),
            Message: `Existing SAP material document found by Case ID '${caseId}'`
        };
    }

    async findResultByCaseId(_key, _scenario, caseId) {
        return this._findResultByCaseId(caseId);
    }

    async reverseMaterialDocument({ MaterialDocument, MaterialDocumentYear }) {
        const api = await cds.connect.to(SERVICES.document);
        const path = `/Cancel?MaterialDocumentYear='${escapeOData(MaterialDocumentYear)}'&MaterialDocument='${escapeOData(MaterialDocument)}'`;
        const response = await api.send('POST', path, {}, { accept: 'application/json', 'content-type': 'application/json' });
        const result = resultOf(response);
        return {
            success: !!(result.ReversalMaterialDocument || result.MaterialDocument),
            MaterialDocument: result.ReversalMaterialDocument || result.MaterialDocument,
            MaterialDocumentYear: result.ReversalMaterialDocumentYear || result.MaterialDocumentYear,
            Message: result.Message || 'SAP material document cancelled'
        };
    }
}

class MockS4MaterialApi {
    constructor() { this.byKey = new Map(); this.seq = 4900000000; this.year = String(new Date().getFullYear()); }
    _stock() { return cds.entities('aaml.mc').BatchStockSnapshot; }
    async getBatchStock({ material, plant, storageLocation, batch, serviceDate }) {
        const row = await SELECT.one.from(this._stock()).where({ Material: material, Plant: plant, StorageLocation: storageLocation, Batch: batch });
        if (!row) return null;
        const flags = eligibleBatch(row, row, row, serviceDate);
        return flags.eligible && Number(row.InventoryStockType || '01') === 1 && !String(row.InventorySpecialStockType || '').trim()
            ? { ...row, ShelfLifeExpirationDate: dateOnly(row.ShelfLifeExpirationDate) || null } : null;
    }
    async listBatchStock({ material, plant, storageLocation, serviceDate }) {
        const rows = await SELECT.from(this._stock()).where({ Material: material, Plant: plant, StorageLocation: storageLocation });
        return rows.filter(row => {
            const flags = eligibleBatch(row, row, row, serviceDate);
            return flags.eligible && Number(row.InventoryStockType || '01') === 1
                && !String(row.InventorySpecialStockType || '').trim() && Number(row.UnrestrictedQty) > 0 && row.Batch;
        }).map(row => ({ ...row, ShelfLifeExpirationDate: dateOnly(row.ShelfLifeExpirationDate) || null }));
    }
    async getMaterialStock({ material, plant, storageLocation }) {
        const rows = await SELECT.from(this._stock()).where({ Material: material, Plant: plant, StorageLocation: storageLocation });
        return rows.filter(row => Number(row.InventoryStockType || '01') === 1 && !String(row.InventorySpecialStockType || '').trim())
            .reduce((sum, row) => sum + Number(row.UnrestrictedQty || 0), 0);
    }
    async findResultByCaseId(key) { return this.byKey.get(key) || null; }
    async postMaterialDocument(payload) {
        const existing = this.byKey.get(payload.IdempotencyKey);
        if (existing) return existing;
        if (!payload.Items?.length || payload.Items.some(item => !(Number(item.Quantity) > 0)))
            return { success: false, Message: 'Mock posting: every material document item must have a positive quantity' };
        const result = {
            success: true,
            MaterialDocument: String(++this.seq),
            MaterialDocumentYear: this.year,
            Items: payload.Items.map(item => ({ MaterialDocumentLine: item.MaterialDocumentLine, MaterialDocumentItem: String(item.MaterialDocumentLine).padStart(6, '0') })),
            Message: 'Mock posting successful'
        };
        this.byKey.set(payload.IdempotencyKey, result);
        return result;
    }
    async reverseMaterialDocument(payload) {
        const key = payload.IdempotencyKey;
        if (this.byKey.has(key)) return this.byKey.get(key);
        const result = { success: true, MaterialDocument: String(++this.seq), MaterialDocumentYear: this.year, Message: 'Mock reversal successful' };
        this.byKey.set(key, result);
        return result;
    }
}

class ConfiguredS4MaterialApi {
    constructor() {
        this.remote = new RemoteS4MaterialApi();
        this.mock = new MockS4MaterialApi();
    }

    _reader() { return remoteReadsEnabled() ? this.remote : this.mock; }
    _writer(scenario) { return remotePostingEnabled(scenario) ? this.remote : this.mock; }

    getBatchStock(args) { return this._reader().getBatchStock(args); }
    listBatchStock(args) { return this._reader().listBatchStock(args); }
    getMaterialStock(args) { return this._reader().getMaterialStock(args); }
    findResultByCaseId(key, scenario, caseId) {
        return this._writer(scenario).findResultByCaseId(key, scenario, caseId);
    }
    postMaterialDocument(payload) { return this._writer(payload.PostingScenario).postMaterialDocument(payload); }
    reverseMaterialDocument(payload) { return this._writer(payload.PostingScenario).reverseMaterialDocument(payload); }
}

let instance;
const getS4Api = () => instance || (instance = new ConfiguredS4MaterialApi());
module.exports = { getS4Api, NotConfiguredError, getRemotePostingConfigIssues };
