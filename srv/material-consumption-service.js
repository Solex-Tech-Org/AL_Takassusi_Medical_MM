'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const cds = require('@sap/cds');
const cc = require('./lib/case-consumption');
const dc = require('./lib/daily-close');
const sn = require('./lib/shared-nursing');
const cs = require('./lib/case-sessions');

/** Thin handler layer: all business logic lives in srv/lib + /common. */
module.exports = class MaterialConsumptionService extends cds.ApplicationService {
  init() {
    this.on('receiveFromRis', req => cc.receiveFromRis(req.data.rows));
    this.on('calculateNuclear', req => cc.calculateRows(req.data.ids));
    this.on('postSelected', req => cc.postSelected(req.data.ids));
    this.on('reversePrimary', req => cc.reversePrimary(req.data, req.user.id));
    this.on('determineLiquidBatch', req => cc.determineLiquidBatch(req.data.serviceDate));
    this.on('determinePowderBatch', req => cc.determinePowderBatch(req.data));
    this.on('calculateWaste', req => dc.previewWaste(req.data.serviceDate));
    this.on('executeDailyClose', req => dc.executeDailyClose(req.data.serviceDate));
    this.on('reverseWaste', req => dc.reverseWaste(req.data.dailyCloseId, req.data.reason));
    this.on('getNuclearPostingStatus', req => dc.getNuclearPostingStatus(req.data.caseId));
    this.on('searchNursingMaterials', req => sn.search(req.data));
    this.on('deriveSharedAssignment', req => sn.derive(req.data.hospital, req.data.modality));
    this.on('validateShared', req => sn.validate(req.data.input));
    this.on('postShared', req => sn.post(req.data.input));
    this.on('openSession', req => cs.openSession(req));
    this.after('READ', 'CaseSessions', result => cs.fillCounts(result));
    return super.init();
  }
};