'use strict';
/** Reader for the custom YY1_AAML_SLOC_MAPPING service described in the FSD. */
const cds = require('@sap/cds');

const SERVICE = 'AAML_SlocMappingApi';
class NotConfiguredError extends Error { }
const validFieldName = value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value || '').trim());
const escapeOData = value => String(value ?? '').replace(/'/g, "''");
const rowsOf = data => {
    // CAP's OData V2 client unwraps d.results to a plain array before returning it.
    if (Array.isArray(data)) return data;
    const rows = data?.value ?? data?.results ?? data?.d?.results ?? data?.d ?? [];
    return Array.isArray(rows) ? rows : (rows ? [rows] : []);
};

async function findByHospitalAndModality(hospital, modality, plant = '1100') {
    const path = String(cds.env.aaml?.s4?.slocMappingPath || '').trim();
    if (!path || !path.startsWith('/') || path === '/') throw new NotConfiguredError('Configure the custom SLoc mapping API path (aaml.s4.slocMappingPath) with a leading /');
    const fields = cds.env.aaml?.s4?.slocMappingFields || {};
    const field = (key, fallback) => String(fields[key] || fallback);
    const plantField = field('plant', 'Plant');
    const storageLocationField = field('storageLocation', 'StorageLocation');
    const hospitalSearchTermField = field('hospitalSearchTerm', 'AddressSearchTerm1');
    const modalitySearchTermField = field('modalitySearchTerm', 'AddressSearchTerm2');
    const invalid = [plantField, storageLocationField, hospitalSearchTermField, modalitySearchTermField].filter(name => !validFieldName(name));
    if (invalid.length) throw new NotConfiguredError(`Invalid SLoc mapping field name(s): ${invalid.join(', ')}`);
    const api = await cds.connect.to(SERVICE);
    const filter = `${plantField} eq '${escapeOData(plant)}'`;
    const select = [plantField, storageLocationField, hospitalSearchTermField, modalitySearchTermField].join(',');
    const data = await api.send('GET', `${path}${path.includes('?') ? '&' : '?'}$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent(select)}&$format=json`, undefined,
        { accept: 'application/json' });
    return rowsOf(data).filter(row => {
        if (String(row[plantField] || '').trim() !== String(plant)) return false;
        if (String(row[hospitalSearchTermField] || '').trim() !== String(hospital).trim()) return false;
        const tokens = String(row[modalitySearchTermField] || '').split(',').map(token => token.trim()).filter(Boolean);
        return tokens.includes(String(modality).trim());
    }).map(row => ({ Plant: String(row[plantField]).trim(), StorageLocation: String(row[storageLocationField] || '').trim() }));
}

module.exports = { findByHospitalAndModality, NotConfiguredError };