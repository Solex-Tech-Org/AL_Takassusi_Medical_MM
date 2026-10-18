namespace aaml.mc;

using {
    cuid,
    managed
} from '@sap/cds/common';

type MaterialClass   : String(20) enum {
    Normal;
    NuclearLiquid;
    NuclearPowder;
    NursingShared;
};

type NuclearModel    : String(20) enum {
    LiquidDaily;
    PowderLongLife;
};

type RowStatus       : String(20) enum {
    Received;
    Ready;
    Blocked;
    NeedsCorrection;
    Posted;
    Excluded;
    Reversed;
};

type PostingScenario : String(20) enum {
    Normal;
    NuclearConsumption;
    NuclearWaste;
    NursingShared;
};

type PostingCategory : String(20) enum {
    NMConsumption;
    NMWaste;
};

type Qty             : Decimal(15, 3);

// ---------------------------------------------------------------
// Case consumption row (one RIS source row = one waiting row)
// managed => createdAt/createdBy/modifiedAt/modifiedBy
// ---------------------------------------------------------------
@assert.unique: {
    SourceRecord: [SourceRecordId],
    Idempotency : [IdempotencyKey]
}
entity ConsumptionRequests : cuid, managed {
    // --- RIS source facts (user-facing) ---
    CaseId                   : String(40) @mandatory;
    SourceRecordId           : String(80) @mandatory;
    ProcedureCode            : String(40);
    ServiceDateTime          : Timestamp;
    ServiceDate              : Date;
    Hospital                 : String(20);
    Modality                 : String(20);
    Quantity                 : Qty;
    EntryUnit                : String(10);
    ActualMci                : Qty;
    // --- determined / calculated (user-facing, read-only) ---
    Material                 : String(40);
    MaterialDescription      : String(120);
    MaterialClass            : MaterialClass;
    NuclearModel             : NuclearModel;
    MaximumMciPerVial        : Qty;
    CalculatedVials          : Qty;
    Batch                    : String(60);
    BatchSource              : String(20); // LIQUID_EXACT_DATE | FEFO
    EstimatedWaste           : Qty; // Powder estimate; Liquid = "At close"
    Plant                    : String(10);
    StorageLocation          : String(10);
    CostCenter               : String(20);
    Status                   : RowStatus default 'Received';
    ErrorMessage             : String(500);
    // --- posting result (user-facing) ---
    SAPMaterialDocument      : String(10);
    SAPMaterialDocumentYear  : String(4);
    SAPMaterialDocumentItem  : String(6);
    // --- technical (not exposed to normal UI) ---
    PostingScenario          : PostingScenario;
    PostingCategory          : PostingCategory;
    CorrelationId            : String(80);
    ExternalDocumentId       : String(80);
    IdempotencyKey           : String(80);
    DailyCloseId             : UUID;
    DailyGroupKey            : String(40);
    PrimaryDocumentReference : String(40);
    AllocationShare          : Decimal(9, 6);
    Action                   : String(10) default 'Create';
    Version                  : Integer default 1; // RIS version (ordering)
    SourceTimestamp          : Timestamp;
    PostingVersion           : Integer default 1; // bumped after reversal -> new idempotency key
    BatchAllocations         : Composition of many BatchAllocations
                                   on BatchAllocations.Request = $self;
    PostingLogs              : Composition of many PostingLogs
                                   on PostingLogs.Request = $self;
    ValidationEvents         : Composition of many ValidationEvents
                                   on ValidationEvents.Request = $self;
}

// Source batches used by a primary posting (Liquid: 1 row; Powder FEFO: 1..n)
entity BatchAllocations : cuid {
    Request                 : Association to ConsumptionRequests;
    Sequence                : Integer;
    Batch                   : String(40);
    ShelfLifeExpirationDate : Date;
    Vials                   : Qty;
    Mci                     : Qty;
}

entity ValidationEvents : cuid, managed {
    Request : Association to ConsumptionRequests;
    Source  : String(10); // RIS | USER | SYSTEM
    Code    : String(40);
    Message : String(500);
}

// One log row per attempt towards the Z Material API (also SAP-result report)
entity PostingLogs : cuid, managed {
    Request                 : Association to ConsumptionRequests;
    DailyClose              : Association to DailyCloses;
    Shared                  : Association to SharedConsumptions;
    Scenario                : PostingScenario;
    IdempotencyKey          : String(80);
    Outcome                 : String(20); // Success | BusinessError | TechnicalError
    Message                 : String(500);
    SAPMaterialDocument     : String(10);
    SAPMaterialDocumentYear : String(4);
}

// ---------------------------------------------------------------
// Consumption session = "معاملة سابقة": كل مرة اليوزر يعمل Create ويحدد From/To
// (الأرقام: إجمالي / اتعمله Post / المتبقي بتتحسب وقت القراءة من ConsumptionRequests)
// ---------------------------------------------------------------
@assert.unique: {Period: [DateFrom, DateTo]}
entity ConsumptionSessions : cuid, managed {
    SessionNo : String(20); // CS-0001 ...
    DateFrom  : Date;
    DateTo    : Date;
}

// ---------------- Nuclear daily close / automatic NM waste ----------------
entity DailyCloses : cuid, managed {
    ServiceDate             : Date;
    DailyGroupKey           : String(40);
    Version                 : Integer default 1;
    Status                  : String(20); // WastePending | Posted | NoWaste | Error | Reversed
    WasteVials              : Qty;
    ErrorMessage            : String(500);
    IdempotencyKey          : String(80);
    SAPMaterialDocument     : String(10);
    SAPMaterialDocumentYear : String(4);
    Allocations             : Composition of many WasteAllocations
                                  on Allocations.DailyClose = $self;
}

entity WasteAllocations : cuid {
    DailyClose               : Association to DailyCloses;
    Request                  : Association to ConsumptionRequests;
    CaseId                   : String(40);
    Hospital                 : String(20);
    Modality                 : String(20);
    Material                 : String(40);
    Plant                    : String(10);
    StorageLocation          : String(10);
    Batch                    : String(40);
    NuclearModel             : NuclearModel;
    ReceivedOrOpenedVials    : Qty; // Liquid: received vials; Powder: opened vials (per source batch)
    ActualVials              : Qty; // total actual vials of the source batch (day)
    WasteVials               : Qty;
    WasteMci                 : Qty;
    AllocationShare          : Decimal(9, 6);
    PrimaryDocumentReference : String(40);
    Status                   : String(20); // Pending | Posted | Error | Reversed
    SAPMaterialDocument      : String(10);
    SAPMaterialDocumentYear  : String(4);
    SAPMaterialDocumentItem  : String(6);
}

entity Reversals : cuid, managed {
    Scope                : String(10); // Primary | Waste
    Request              : Association to ConsumptionRequests;
    DailyClose           : Association to DailyCloses;
    OriginalDocument     : String(10);
    OriginalDocumentYear : String(4);
    ReversalDocument     : String(10);
    ReversalDocumentYear : String(4);
    Reason               : String(255);
    ReplacementPosting   : String(40);
}

// ---------------- Shared Nursing ----------------
@assert.unique: {Idempotency: [IdempotencyKey]}
entity SharedConsumptions : cuid, managed {
    PostingDate             : Date;
    Hospital                : String(20);
    Modality                : String(20);
    Plant                   : String(10);
    StorageLocation         : String(10);
    CostCenter              : String(20);
    Status                  : String(20); // Posted | Error
    IdempotencyKey          : String(80);
    CorrelationId           : String(80);
    ExternalDocumentId      : String(80);
    SAPMaterialDocument     : String(10);
    SAPMaterialDocumentYear : String(4);
    ErrorMessage            : String(500);
    Items                   : Composition of many SharedConsumptionItems
                                  on Items.Parent = $self;
}

entity SharedConsumptionItems : cuid {
    Parent                  : Association to SharedConsumptions;
    Line                    : Integer;
    Material                : String(40);
    MaterialDescription     : String(120);
    Quantity                : Qty;
    BUOM                    : String(10);
    SAPMaterialDocumentItem : String(6);
    Message                 : String(255);
}

// ---------------- Configuration / master-data mirrors ----------------
// In production these values come from SAP material master / MM-FI configuration
// via the integration layer. Local tables = replaceable staging/config.
entity MaterialMaster {
    key Material      : String(40);
        Description   : String(120);
        MaterialType  : String(20); // Normal | Nuclear | Nursing
        NuclearModel  : NuclearModel; // mandatory when MaterialType = Nuclear
        BaseUnit      : String(10);
        MaxMciPerVial : Qty;
        Active        : Boolean default true;
}

entity ProcedureMaterialMap {
    key ProcedureCode : String(40);
        Material      : String(40);
}

entity HospitalModalityMap : cuid {
    Hospital        : String(20);
    Modality        : String(20);
    Plant           : String(10);
    StorageLocation : String(10);
    CostCenter      : String(20);
    CopaAssignment  : String(60); // PLACEHOLDER: real CO-PA characteristics not in FSD
    Active          : Boolean default true;
}

entity MovementTypeConfig {
    key Scenario          : PostingScenario;
        GoodsMovementType : String(10); // approved custom GI type; Z01 prohibited
        GoodsMovementCode : String(10); // header code (to be confirmed with Z API)
        Active            : Boolean default true;
}

// MOCK ONLY: stands in for S/4 batch/stock reads (see common/integration)
entity BatchStockSnapshot : cuid {
    Material                : String(40);
    Plant                   : String(10);
    StorageLocation         : String(10);
    Batch                   : String(40);
    UnrestrictedQty         : Qty;
    ReceivedQty             : Qty;
    ShelfLifeExpirationDate : Date;
}
