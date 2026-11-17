using {aaml.mc as db} from '../../db/schema';
extend service MaterialConsumptionService {
    @readonly
    entity Hospitals as projection on db.Hospitals;
    @readonly
    entity Modalities as projection on db.Modalities;
    entity HospitalModalityMappings as projection on db.HospitalModalityMap {
        key ID,
        Hospital.Code as Hospital,
        Modality.Code as Modality,
        Plant,
        StorageLocation,
        CostCenter,
        CopaAssignment,
        Active
    };
    // API-friendly names for the hospital/modality/storage-location lookup.
    // This is another projection over the existing mapping table, not a second store.
    entity HospitalModalitySLocMappings as projection on db.HospitalModalityMap {
        key ID,
        Hospital.Code as HospitalId,
        Modality.Code as ModalityId,
        StorageLocation as StorageLocationId
    };
    entity ModalityProfitCenterMappings as projection on db.ModalityProfitCenterMappings;
}
