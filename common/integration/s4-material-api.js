'use strict';
/**
 * Abstraction of the SAP S/4HANA Z Material API + batch/stock reads.
 * UI and business logic only talk to this interface; no SAP endpoint/auth
 * details are invented. 'mock' (default, dev) simulates it; 'remote' is a stub.
 *
 *  getBatchStock({material,plant,storageLocation,batch}) -> {Batch,UnrestrictedQty,ReceivedQty,ShelfLifeExpirationDate}|null
 *  listBatchStock({material,plant,storageLocation})      -> same shape[] (unrestricted > 0)
 *  getMaterialStock({material,plant,storageLocation})    -> number
 *  postMaterialDocument(payload) -> {success,MaterialDocument,MaterialDocumentYear,Items:[{MaterialDocumentLine,MaterialDocumentItem}],Message}
 *  findResultByIdempotencyKey(key) -> same | null   (used after technical timeouts)
 *  reverseMaterialDocument({MaterialDocument,MaterialDocumentYear,Reason,IdempotencyKey}) -> {success,MaterialDocument,MaterialDocumentYear,Message}
 */
const cds = require('@sap/cds');
const { SELECT } = cds.ql;

class NotConfiguredError extends Error { }

class RemoteS4MaterialApi {
    // TODO(CONFIG_PLACEHOLDER): implement via BTP destination (cds.env.aaml.s4.destination)
    // once endpoint, authentication and final Z API field names are provided.
    _na() { throw new NotConfiguredError('S/4HANA Z Material API is not configured (cds.env.aaml.s4)'); }
    getBatchStock() { return this._na(); }
    listBatchStock() { return this._na(); }
    getMaterialStock() { return this._na(); }
    postMaterialDocument() { return this._na(); }
    findResultByIdempotencyKey() { return this._na(); }
    reverseMaterialDocument() { return this._na(); }
}

class MockS4MaterialApi {
    constructor() { this.byKey = new Map(); this.seq = 4900000000; this.year = String(new Date().getFullYear()); }
    _stock() { return cds.entities('aaml.mc').BatchStockSnapshot; }
    async getBatchStock({ material, plant, storageLocation, batch }) {
        return (await SELECT.one.from(this._stock()).where({ Material: material, Plant: plant, StorageLocation: storageLocation, Batch: batch })) || null;
    }
    async listBatchStock({ material, plant, storageLocation }) {
        const rows = await SELECT.from(this._stock()).where({ Material: material, Plant: plant, StorageLocation: storageLocation });
        return rows.filter(r => Number(r.UnrestrictedQty) > 0 && r.Batch);
    }
    async getMaterialStock({ material, plant, storageLocation }) {
        const rows = await SELECT.from(this._stock()).where({ Material: material, Plant: plant, StorageLocation: storageLocation });
        return rows.reduce((s, r) => s + Number(r.UnrestrictedQty), 0);
    }
    async findResultByIdempotencyKey(key) { return this.byKey.get(key) || null; }
    async postMaterialDocument(p) {
        const existing = this.byKey.get(p.IdempotencyKey);
        if (existing) return existing;                                    // duplicate protection
        if (p.Items.some(i => !(Number(i.Quantity) > 0))) return { success: false, Message: 'Mock Z API: quantity must be positive' };
        const res = {
            success: true, MaterialDocument: String(++this.seq), MaterialDocumentYear: this.year,
            Items: p.Items.map(i => ({ MaterialDocumentLine: i.MaterialDocumentLine, MaterialDocumentItem: String(i.MaterialDocumentLine).padStart(4, '0') })),
            Message: 'Mock posting successful'
        };
        this.byKey.set(p.IdempotencyKey, res);
        return res;
    }
    async reverseMaterialDocument(r) {
        const key = r.IdempotencyKey; if (this.byKey.has(key)) return this.byKey.get(key);
        const res = { success: true, MaterialDocument: String(++this.seq), MaterialDocumentYear: this.year, Message: 'Mock reversal successful' };
        this.byKey.set(key, res); return res;
    }
}

let instance;
const getS4Api = () => instance || (instance = (cds.env.aaml?.s4?.mode === 'remote') ? new RemoteS4MaterialApi() : new MockS4MaterialApi());
module.exports = { getS4Api, NotConfiguredError };
