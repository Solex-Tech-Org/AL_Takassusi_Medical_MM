sap.ui.define(["sap/ui/model/json/JSONModel"], function (JSONModel) {
    "use strict";
    return {
        // شاشة سجل المعاملات (فلاتر Transaction ID / Date)
        createSessionsModel: () => new JSONModel({ canClear: false }),
        // صفحة اختيار الفترة (From / To)
        createPeriodModel: () => new JSONModel({ canClear: false, busy: false }),
        // صفحة الـ Filters + Cases
        createCaseModel: () => new JSONModel({
            busy: false, periodText: "", selectedCount: 0, selectedText: "", canClearFilters: false
        }),
        createSharedModel: () => new JSONModel({
            PostingDate: new Date().toISOString().slice(0, 10), Hospital: "", Modality: "", CostCenter: "", Plant: "",
            Pairs: [], Hospitals: [], Modalities: [], Items: [], Suggestions: [], ClientRequestId: crypto.randomUUID(), busy: false
        })
    };
});