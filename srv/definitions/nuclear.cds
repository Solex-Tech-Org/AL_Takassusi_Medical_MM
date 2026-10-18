using {aaml.mc as db} from '../../db/schema';

extend service MaterialConsumptionService {

    @readonly
    entity NuclearDetails as
        projection on db.ConsumptionRequests {
            ID,
            CaseId,
            ServiceDate,
            Hospital,
            Modality,
            Material,
            MaterialClass,
            NuclearModel,
            ActualMci,
            MaximumMciPerVial,
            CalculatedVials,
            Batch,
            BatchSource,
            EstimatedWaste,
            Plant,
            StorageLocation,
            Status,
            ErrorMessage,
            DailyCloseId,
            PrimaryDocumentReference,
            BatchAllocations
        }
        where
            MaterialClass in (
                'NuclearLiquid', 'NuclearPowder'
            );


    @readonly
    entity WasteReport    as projection on db.WasteAllocations;


    @readonly
    entity DailyCloses    as projection on db.DailyCloses;


    @readonly
    entity Reversals      as projection on db.Reversals;


    type PowderBatchPick {
        Batch                   : String;
        ShelfLifeExpirationDate : Date;
        Vials                   : Decimal(15, 3);
    }

    type WastePreview {
        Material              : String;
        Batch                 : String;
        NuclearModel          : String;
        ActualVials           : Decimal(15, 3);
        OpenedOrReceivedVials : Decimal(15, 3);
        WasteVials            : Decimal(15, 3);
        WasteMci              : Decimal(15, 3);
        CaseId                : String;
        AllocationShare       : Decimal(9, 6);
        AllocatedVials        : Decimal(15, 3);
    }

    type DailyCloseResult {
        DailyCloseId            : UUID;
        ServiceDate             : Date;
        Version                 : Integer;
        Status                  : String;
        Message                 : String;
        SAPMaterialDocument     : String;
        SAPMaterialDocumentYear : String;
    }

    type NuclearStatus {
        CaseId          : String;
        PrimaryStatus   : String;
        PrimaryDocument : String;
        WasteStatus     : String;
        WasteDocument   : String;
        DailyCloseId    : UUID;
    }


    function determineLiquidBatch(serviceDate: Date)     returns String;

    function determinePowderBatch(material: String,
                                  hospital: String,
                                  modality: String,
                                  vials: Decimal(15, 3)) returns many PowderBatchPick;

    function calculateWaste(serviceDate: Date)           returns many WastePreview;

    action   executeDailyClose(serviceDate: Date)        returns DailyCloseResult;

    action   reverseWaste(dailyCloseId: UUID,
                          reason: String)                returns DailyCloseResult;

    function getNuclearPostingStatus(caseId: String)     returns many NuclearStatus;
}
