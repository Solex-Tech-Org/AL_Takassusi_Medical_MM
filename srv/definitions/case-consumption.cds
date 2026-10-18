using {aaml.mc as db} from '../../db/schema';

extend service MaterialConsumptionService {

    @readonly
    entity CaseConsumption      as
        projection on db.ConsumptionRequests {
            ID,
            CaseId,
            ServiceDate,
            Hospital,
            Modality,
            Material,
            MaterialDescription,
            MaterialClass,
            Quantity,
            EntryUnit,
            ActualMci,
            MaximumMciPerVial,
            CalculatedVials,
            Batch,
            EstimatedWaste,
            Plant,
            StorageLocation,
            Status,
            ErrorMessage,
            SAPMaterialDocument,
            SAPMaterialDocumentYear,
            SAPMaterialDocumentItem
        }
        where
            Status in (
                'Received', 'Ready', 'Blocked', 'NeedsCorrection'
            );


    @readonly
    @requires: 'authenticated-user'
    entity ConsumptionTechnical as projection on db.ConsumptionRequests;


    type RisRow {
        CaseId          : String;
        SourceRecordId  : String;
        ProcedureCode   : String;
        Material        : String;
        ServiceDateTime : Timestamp;
        Hospital        : String;
        Modality        : String;
        Quantity        : Decimal(15, 3);
        EntryUnit       : String;
        ActualMci       : Decimal(15, 3);
        Action          : String;
        Version         : Integer;
        SourceTimestamp : Timestamp;
        CorrelationId   : String;
        Batch           : String;
    }

    type RowResult {
        ID                      : UUID;
        CaseId                  : String;
        Status                  : String;
        Message                 : String;
        SAPMaterialDocument     : String;
        SAPMaterialDocumentYear : String;
        SAPMaterialDocumentItem : String;
    }


    action receiveFromRis(rows: many RisRow)                         returns many RowResult;

    action calculateNuclear(ids: many UUID)                          returns many RowResult;

    action postSelected(ids: many UUID)                              returns many RowResult;

    action reversePrimary(ID: UUID, reason: String, repost: Boolean) returns RowResult;
}
