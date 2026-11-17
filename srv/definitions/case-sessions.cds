using {aaml.mc as db} from '../../db/schema';
extend service MaterialConsumptionService {
    // سجل المعاملات السابقة (Create -> From/To -> Get Consumption).
    // TotalCases / PostedCases / RemainingCases / SessionStatus بتتحسب في srv/lib/case-sessions.js وقت القراءة.
    @readonly
    entity CaseSessions as
        projection on db.ConsumptionSessions {
            ID,
            SessionNo,
            DateFrom,
            DateTo,
            createdAt,
            createdBy,
            virtual null as TotalCases     : Integer,
            virtual null as PostedCases    : Integer,
            virtual null as RemainingCases : Integer,
            virtual null as SessionStatus  : String
        };
    // Structured response for openSession; action return types must be types
    // or entities exposed by this service.
    type OpenSessionResult {
        ID              : UUID;
        SessionNo       : String(20);
        DateFrom        : Date;
        DateTo          : Date;
        createdAt       : Timestamp;
        createdBy       : String(255);
        TotalCases      : Integer;
        PostedCases     : Integer;
        RemainingCases  : Integer;
        SessionStatus   : String;
    }
    type DeleteSessionResult {
        ID           : UUID;
        SessionNo    : String(20);
        DeletedCases : Integer;
    }
    // بيفتح معاملة للفترة دي، ولو نفس الفترة اتعملت قبل كده بيرجّع نفس المعاملة (من غير تكرار).
    action openSession(dateFrom: Date, dateTo: Date) returns OpenSessionResult;
    // حذف معاملة غير مُرحّلة وحالاتها التابعة.
    action deleteSession(ID: UUID) returns DeleteSessionResult;
}
