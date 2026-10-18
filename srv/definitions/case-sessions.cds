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

    // بيفتح معاملة للفترة دي، ولو نفس الفترة اتعملت قبل كده بيرجّع نفس المعاملة (من غير تكرار).
    action openSession(dateFrom: Date, dateTo: Date) returns CaseSessions;
}
