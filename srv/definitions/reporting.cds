using {aaml.mc as db} from '../../db/schema';

extend service MaterialConsumptionService {

    @readonly
    entity HospitalModalities as
        projection on db.HospitalModalityMap {
            key ID,
                Hospital,
                Modality,
                CostCenter,
                Plant,
                StorageLocation
        }
        where
            Active = true;


    @readonly
    @cds.redirection.target
    entity ConsumptionHistory as
        projection on db.ConsumptionRequests {
            ID,
            CaseId,
            ServiceDate,
            Hospital,
            Modality,
            Material,
            MaterialDescription,
            MaterialClass,
            PostingScenario,
            PostingCategory,
            Quantity,
            EntryUnit,
            ActualMci,
            MaximumMciPerVial,
            CalculatedVials,
            Batch,
            Status,
            ErrorMessage,
            DailyCloseId,
            SAPMaterialDocument,
            SAPMaterialDocumentYear,
            SAPMaterialDocumentItem,
            modifiedAt,
            modifiedBy
        };


    @readonly
    entity SAPDocumentResults as projection on db.PostingLogs;


    @readonly
    entity ConsumptionErrors  as
        projection on db.ConsumptionRequests {
            ID,
            CaseId,
            SourceRecordId,
            ServiceDate,
            Hospital,
            Modality,
            Material,
            MaterialClass,
            Status,
            ErrorMessage,
            ActualMci,
            Quantity,
            EntryUnit
        }
        where
            Status in (
                'Blocked', 'NeedsCorrection'
            );
}
