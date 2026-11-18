'use strict';
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const cds = require('@sap/cds');
const cc = require('./lib/case-consumption');
const dc = require('./lib/daily-close');
const sn = require('./lib/shared-nursing');
const cs = require('./lib/case-sessions');
const { SELECT, INSERT, UPDATE } = cds.ql;

/** Thin handler layer: all business logic lives in srv/lib + /common. */
module.exports = class MaterialConsumptionService extends cds.ApplicationService {
  init() {
    const validateHospitalModalityMapping = async (req, isUpdate) => {
      const { Hospitals, Modalities, HospitalModalityMap } = cds.entities('aaml.mc');
      const key = req.data.ID || (Array.isArray(req.params) && req.params.find(param => param && param.ID)?.ID);
      const stored = isUpdate && key ? await SELECT.one.from(HospitalModalityMap).where({ ID: key }) : null;
      if (isUpdate && !stored) return req.reject(404, 'Hospital + Modality mapping was not found.');
      const current = stored && { ...stored, Hospital: stored.Hospital_Code, Modality: stored.Modality_Code };

      const merged = { ...(current || {}), ...req.data };
      const Hospital = String(merged.Hospital || '').trim();
      const Modality = String(merged.Modality || '').trim();
      const Plant = String(merged.Plant || '').trim();
      const StorageLocation = String(merged.StorageLocation || '').trim();
      if (!Hospital) return req.reject(400, 'Hospital is required.');
      if (!Modality) return req.reject(400, 'Modality is required.');
      if (!Plant) return req.reject(400, 'Plant is required for case consumption.');
      if (!StorageLocation) return req.reject(400, 'StorageLocation is required for case consumption.');
      if (!await SELECT.one.from(Hospitals).where({ Code: Hospital })) {
        return req.reject(400, `Unknown Hospital code '${Hospital}'. Read valid codes from the Hospitals entity.`);
      }
      if (!await SELECT.one.from(Modalities).where({ Code: Modality })) {
        return req.reject(400, `Unknown Modality code '${Modality}'. Read valid codes from the Modalities entity.`);
      }

      const active = merged.Active !== false;
      if (active) {
        const samePair = await SELECT.from(HospitalModalityMap).where({ Hospital_Code: Hospital, Modality_Code: Modality, Active: true });
        if (samePair.some(mapping => mapping.ID !== key)) {
          return req.reject(409, `An active mapping already exists for Hospital '${Hospital}' and Modality '${Modality}'.`);
        }
      }

      Object.assign(req.data, { Hospital, Modality, Plant, StorageLocation });
      if (Object.prototype.hasOwnProperty.call(merged, 'CostCenter')) req.data.CostCenter = String(merged.CostCenter || '').trim() || null;
      if (Object.prototype.hasOwnProperty.call(merged, 'CopaAssignment')) req.data.CopaAssignment = String(merged.CopaAssignment || '').trim() || null;
    };

    const normalizeSLocApiMapping = async (req, stored, excludeId) => {
      const { Hospitals, Modalities, HospitalModalityMap } = cds.entities('aaml.mc');
      const HospitalId = String(req.data.HospitalId ?? stored?.Hospital_Code ?? '').trim();
      const ModalityId = String(req.data.ModalityId ?? stored?.Modality_Code ?? '').trim();
      const StorageLocationId = String(req.data.StorageLocationId ?? stored?.StorageLocation ?? '').trim();
      const Plant = String(stored?.Plant || cds.env.aaml?.s4?.plant || '1100').trim();
      if (!HospitalId) return req.reject(400, 'HospitalId is required.');
      if (!ModalityId) return req.reject(400, 'ModalityId is required.');
      if (!StorageLocationId) return req.reject(400, 'StorageLocationId is required.');
      if (!await SELECT.one.from(Hospitals).where({ Code: HospitalId })) {
        return req.reject(400, `Unknown HospitalId '${HospitalId}'. Read valid codes from the Hospitals entity.`);
      }
      if (!await SELECT.one.from(Modalities).where({ Code: ModalityId })) {
        return req.reject(400, `Unknown ModalityId '${ModalityId}'. Read valid codes from the Modalities entity.`);
      }
      const samePair = await SELECT.from(HospitalModalityMap).where({
        Hospital_Code: HospitalId,
        Modality_Code: ModalityId,
        Active: true
      });
      if (samePair.some(mapping => mapping.ID !== excludeId)) {
        return req.reject(409, `An active mapping already exists for HospitalId '${HospitalId}' and ModalityId '${ModalityId}'.`);
      }
      return { HospitalId, ModalityId, StorageLocationId, Plant };
    };

    this.before('CREATE', 'ModalityProfitCenterMappings', async req => {
      const code = String(req.data.Modality || '').trim();
      if (!code) return req.reject(400, 'Modality is required.');
      const { Modalities } = cds.entities('aaml.mc');
      const modality = await SELECT.one.from(Modalities).where({ Code: code });
      if (!modality) return req.reject(400, `Unknown Modality code '${code}'. Read valid codes from the Modalities entity.`);
      req.data.Modality = code;
      req.data.ProfitCenter = String(req.data.ProfitCenter || '').trim();
      if (!req.data.ProfitCenter) return req.reject(400, 'ProfitCenter is required.');
    });
    this.before('CREATE', 'HospitalModalityMappings', req => validateHospitalModalityMapping(req, false));
    this.before('UPDATE', 'HospitalModalityMappings', req => validateHospitalModalityMapping(req, true));
    this.on('CREATE', 'HospitalModalitySLocMappings', async req => {
      const { HospitalModalityMap } = cds.entities('aaml.mc');
      const values = await normalizeSLocApiMapping(req);
      const ID = crypto.randomUUID();
      await this.run(INSERT.into(HospitalModalityMap).entries({
        ID,
        Hospital_Code: values.HospitalId,
        Modality_Code: values.ModalityId,
        Plant: values.Plant,
        StorageLocation: values.StorageLocationId,
        Active: true
      }));
      return { ID, HospitalId: values.HospitalId, ModalityId: values.ModalityId, StorageLocationId: values.StorageLocationId };
    });
    this.on('UPDATE', 'HospitalModalitySLocMappings', async req => {
      const { HospitalModalityMap } = cds.entities('aaml.mc');
      const key = req.data.ID || (Array.isArray(req.params) && req.params.find(param => param && param.ID)?.ID);
      const stored = key ? await SELECT.one.from(HospitalModalityMap).where({ ID: key }) : null;
      if (!stored) return req.reject(404, 'Hospital + Modality mapping was not found.');
      const values = await normalizeSLocApiMapping(req, stored, key);
      await this.run(UPDATE(HospitalModalityMap).set({
        Hospital_Code: values.HospitalId,
        Modality_Code: values.ModalityId,
        Plant: values.Plant,
        StorageLocation: values.StorageLocationId,
        Active: true
      }).where({ ID: key }));
      return { ID: key, HospitalId: values.HospitalId, ModalityId: values.ModalityId, StorageLocationId: values.StorageLocationId };
    });

    this.on('receiveFromRis', req => cc.receiveFromRis(req.data.rows, req));
    this.on('calculateNuclear', req => cc.calculateRows(req.data.ids));
    this.on('postSelected', req => cc.postSelected(req.data.ids));
    this.on('refreshSapDocumentItems', () => cc.refreshSapDocumentItems());
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
    this.on('deleteSession', req => cs.deleteSession(req));
    this.on('importCaseConsumption', async req => {
      const { dateFrom, dateTo, rows } = req.data;
      const isoDate = value => {
        const date = String(value || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
        const parsed = new Date(`${date}T00:00:00.000Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
      };
      if (!isoDate(dateFrom) || !isoDate(dateTo) || dateFrom > dateTo) {
        return req.reject(400, 'A valid From and To date are required for the import period.');
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return req.reject(400, 'The workbook does not contain any case rows.');
      }
      if (rows.length > 5000) {
        return req.reject(413, 'Import is limited to 5,000 case rows per workbook.');
      }
      const normalizedRows = [];
      for (let index = 0; index < rows.length; index++) {
        const caseId = String(rows[index].CaseId || '').trim();
        if (!caseId || caseId.length > 40) {
          return req.reject(400, `Case row ${index + 1} must have a Case ID with no more than 40 characters.`);
        }
        const serviceDate = String(rows[index].ServiceDate || '').slice(0, 10);
        if (!isoDate(serviceDate)) {
          return req.reject(400, `Case row ${index + 1} is missing a valid Service Date.`);
        }
        if (serviceDate < dateFrom || serviceDate > dateTo) {
          return req.reject(400, `Case row ${index + 1} has a Service Date outside the selected transaction period.`);
        }
        normalizedRows.push({ ...rows[index], CaseId: caseId, ServiceDate: serviceDate });
      }

      // Identify the same case row independently of the selected transaction period.
      // Keep RIS ProcedureCode and RIS Material Code separate, as required by ProductOldID lookup.
      const textKey = value => String(value == null ? '' : value).trim().toUpperCase();
      const dateKey = value => value instanceof Date
        ? value.toISOString().slice(0, 10)
        : String(value || '').slice(0, 10);
      const rowIdentity = row => JSON.stringify([
        textKey(row.CaseId), dateKey(row.ServiceDate), textKey(row.Hospital || row.Hospital_Code),
        textKey(row.Modality || row.Modality_Code), textKey(row.ProcedureCode), textKey(row.RISMaterialCode || row.Material)
      ]);
      const caseIds = [...new Set(normalizedRows.flatMap(row => [row.CaseId, row.CaseId.toUpperCase(), row.CaseId.toLowerCase()]))];
      const existingIdentities = new Set();
      const { SELECT } = cds.ql;
      const { ConsumptionRequests } = cds.entities('aaml.mc');
      // Chunk the IN filter so large workbooks work with databases that limit bind parameters.
      for (let offset = 0; offset < caseIds.length; offset += 500) {
        const existingRows = await SELECT.from(ConsumptionRequests)
          .columns('CaseId', 'ServiceDate', 'Hospital_Code', 'Modality_Code', 'ProcedureCode', 'RISMaterialCode')
          .where({ CaseId: { in: caseIds.slice(offset, offset + 500) } });
        for (const row of existingRows) existingIdentities.add(rowIdentity(row));
      }

      const seenIdentities = new Set();
      const freshRows = [];
      let duplicateCount = 0;
      for (const row of normalizedRows) {
        const identity = rowIdentity(row);
        if (existingIdentities.has(identity) || seenIdentities.has(identity)) {
          duplicateCount++;
          continue;
        }
        seenIdentities.add(identity);
        freshRows.push({ row, identity });
      }

      // Avoid creating an empty transaction when every imported case already exists.
      if (!freshRows.length) {
        return {
          ID: null,
          SessionNo: null,
          DateFrom: dateFrom,
          DateTo: dateTo,
          ImportedCount: 0,
          DuplicateCount: duplicateCount,
          ReadyCount: 0,
          BlockedCount: 0
        };
      }

      const session = await cs.getOrCreateSession(dateFrom, dateTo, req);
      const sourceRows = freshRows.map(({ row, identity }) => {
        return {
          CaseId: row.CaseId,
          // Stable across sessions so the database unique constraint also protects retries.
          SourceRecordId: `XLSX-${crypto.createHash('sha256').update(identity).digest('hex')}`,
          ProcedureCode: row.ProcedureCode,
          RISMaterialCode: row.RISMaterialCode || row.Material,
          ServiceDate: row.ServiceDate,
          Hospital: row.Hospital,
          Modality: row.Modality,
          Quantity: row.Quantity,
          EntryUnit: row.EntryUnit,
          ActualMci: row.ActualMci,
          Action: 'Create',
          Version: 1
        };
      });
      const results = await cc.receiveFromRis(sourceRows, req);
      const duplicateResults = results.filter(row => row.Message === 'Stale/duplicate RIS version ignored').length;
      const newRows = results.filter(row => row.Message !== 'Stale/duplicate RIS version ignored');
      const ready = newRows.filter(row => row.Status === 'Ready').length;
      return {
        ID: session.ID,
        SessionNo: session.SessionNo,
        DateFrom: session.DateFrom,
        DateTo: session.DateTo,
        ImportedCount: newRows.length,
        DuplicateCount: duplicateCount + duplicateResults,
        ReadyCount: ready,
        BlockedCount: newRows.length - ready
      };
    });
    this.after('READ', 'CaseSessions', result => cs.fillCounts(result));
    return super.init();
  }
};
