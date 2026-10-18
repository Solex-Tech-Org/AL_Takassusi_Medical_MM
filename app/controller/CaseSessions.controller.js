sap.ui.define([
    "aaml/material/controller/BaseController", "aaml/material/model/formatter", "aaml/material/model/models",
    "sap/ui/model/Filter", "sap/ui/model/FilterOperator"
], function (BaseController, formatter, models, Filter, FO) {
    "use strict";

    return BaseController.extend("aaml.material.controller.CaseSessions", {
        formatter: formatter,

        onInit: function () {
            this.getView().setModel(models.createSessionsModel(), "view");
            // الأرقام (Total / Posted / Remaining) بتتغيّر بعد الـ Post، فبنرفرش الجدول كل ما الصفحة تتعرض
            this.refreshOnRoute(["home", "caseSessions"]);
        },

        /** Create: بيفتح صفحة Consumption period (From / To). */
        onCreate: function () {
            this.getOwnerComponent().getRouter().navTo("casePeriod");
        },

        /** الضغط على معاملة سابقة: بيفتح Cases بتاعة نفس الفترة (اللي لسه ما اتعملهاش Post). */
        onSessionPress: function (oEvent) {
            const id = oEvent.getSource().getBindingContext().getProperty("ID");
            this.getOwnerComponent().getRouter().navTo("caseConsumption", { id: id });
        },

        /* ---------------- Filters: Transaction ID + تاريخ ---------------- */

        /** Clear يتفعّل لو أي فلتر فيه قيمة. */
        onFilterInput: function () {
            const has = !!(this.byId("fSessionNo").getValue() || "").trim() || !!this.byId("fDate").getValue();
            this.getView().getModel("view").setProperty("/canClear", has);
        },

        /** Go / Enter: الـ ID بـ Contains (مش حساس لحالة الحروف)، والتاريخ بيجيب أي معاملة فترتها بتشمل اليوم ده. */
        onSearch: function () {
            const filters = [];
            const no = (this.byId("fSessionNo").getValue() || "").trim();
            const date = this.byId("fDate").getValue();
            if (no) { filters.push(new Filter({ path: "SessionNo", operator: FO.Contains, value1: no, caseSensitive: false })); }
            if (date) {
                filters.push(new Filter("DateFrom", FO.LE, date));
                filters.push(new Filter("DateTo", FO.GE, date));
            }
            const binding = this.byId("sessionsTable").getBinding("items");
            if (binding) { binding.filter(filters.length ? new Filter({ filters: filters, and: true }) : []); }
        },

        /** Clear: بيمسح الفلاتر ويرجّع كل المعاملات، وبيشيل الـ focus من الزرار. */
        onClearFilters: function (oEvent) {
            this.byId("fSessionNo").setValue("");
            this.byId("fDate").setValue("");
            this.onFilterInput();
            this.onSearch();
            const dom = oEvent.getSource().getDomRef();
            if (dom && dom.blur) { dom.blur(); }
            const inner = dom && dom.querySelector(".sapMBtnInner");
            if (inner && inner.blur) { inner.blur(); }
        },

        onRefresh: function () {
            const binding = this.byId("sessionsTable").getBinding("items");
            if (binding) { binding.refresh(); }
        },

        onTableUpdated: function (oEvent) {
            const total = oEvent.getParameter("total");
            this.byId("sessionsTitle").setText(`${this.getText("sessionsTitle")} (${total != null ? total : 0})`);
        }
    });
});