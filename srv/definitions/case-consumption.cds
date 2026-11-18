using {aaml.mc as db} from '../../db/schema';

extend service MaterialConsumptionService {
    @readonly
    entity CaseConsumption      as
        projection on db.ConsumptionRequests {
            ID,
            CaseId,
            ProcedureCode,
            ServiceDate,
            Hospital.Code as Hospital,
            Modality.Code as Modality,
            Material,
            RISMaterialCode,
            MaterialDescription,
            MaterialClass,
            SAPProductType,
            Quantity,
            EntryUnit,
            ActualMci,
            PostingQuantity,
            PostingUnit,
            MaximumMciPerVial,
            CalculatedVials,
            Batch,
            BatchDetails,
            BatchExpiryDetails,
            EstimatedWaste,
            Plant,
            StorageLocation,
            Status,
            ErrorMessage,
            SAPMaterialDocument,
            SAPMaterialDocumentYear,
            SAPMaterialDocumentItem,
            BatchAllocations
        }
        where
            Status in (
                'Received', 'Ready', 'Blocked', 'NeedsCorrection', 'Error', 'Posted'
            );

    @readonly
    @requires: 'authenticated-user'
    entity ConsumptionTechnical as projection on db.ConsumptionRequests;

    type RisRow {
        CaseId          : String;
        SourceRecordId  : String;
        ProcedureCode   : String;
        Material        : String;
        RISMaterialCode : String;
        ServiceDate     : Date;
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

    type CaseImportResult {
        ID             : UUID;
        SessionNo      : String;
        DateFrom       : Date;
        DateTo         : Date;
        ImportedCount  : Integer;
        DuplicateCount : Integer;
        ReadyCount     : Integer;
        BlockedCount   : Integer;
    }

    action receiveFromRis(rows: many RisRow)                                      returns many RowResult;
    action importCaseConsumption(dateFrom: Date, dateTo: Date, rows: many RisRow) returns CaseImportResult;
    action calculateNuclear(ids: many UUID)                                       returns many RowResult;
    action postSelected(ids: many UUID)                                           returns many RowResult;
    action refreshSapDocumentItems()                                              returns many RowResult;
    action reversePrimary(ID: UUID, reason: String, repost: Boolean)              returns RowResult;
}
