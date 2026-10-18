'use strict';
const cds = require('@sap/cds');
const { SELECT } = cds.ql;
const V = require('../validation/validators');

const SCENARIO = { Normal: 'Normal', NuclearLiquid: 'NuclearConsumption', NuclearPowder: 'NuclearConsumption', NursingShared: 'NursingShared' };

/** Material Type + Nuclear Consumption Model -> internal class (null = invalid for case rows). */
function classify(master) {
    if (!master) return null;
    if (master.MaterialType === 'Normal') return 'Normal';
    if (master.MaterialType === 'Nuclear') {
        if (master.NuclearModel === 'LiquidDaily') return 'NuclearLiquid';
        if (master.NuclearModel === 'PowderLongLife') return 'NuclearPowder';
    }
    return null; // incl. Nursing: not allowed on case rows
}

/** Material mapping, classification, location (Hospital+Modality) and movement-type determination. */
async function determine(row, prohibited) {
    const { MaterialMaster, ProcedureMaterialMap, HospitalModalityMap, MovementTypeConfig } = cds.entities('aaml.mc');
    let code = row.Material;
    if (!code && row.ProcedureCode)
        code = (await SELECT.one.from(ProcedureMaterialMap).where({ ProcedureCode: row.ProcedureCode }))?.Material;
    const issues = [];
    if (!code) issues.push({ code: 'MATERIAL_NOT_RESOLVED', message: 'SAP material could not be resolved from the procedure code' });
    const master = code ? await SELECT.one.from(MaterialMaster).where({ Material: code }) : null;
    const materialClass = classify(master);
    if (code) issues.push(...V.classification(master, materialClass));
    const maps = row.Hospital && row.Modality
        ? await SELECT.from(HospitalModalityMap).where({ Hospital: row.Hospital, Modality: row.Modality, Active: true }) : [];
    issues.push(...V.location(maps));
    const scenario = SCENARIO[materialClass] || null;
    const mv = scenario ? await SELECT.one.from(MovementTypeConfig).where({ Scenario: scenario }) : null;
    if (scenario) issues.push(...V.movementType(mv, prohibited));
    return { material: code, master, materialClass, scenario, location: maps.length === 1 ? maps[0] : null, movement: mv, issues };
}
module.exports = { classify, determine, SCENARIO };
