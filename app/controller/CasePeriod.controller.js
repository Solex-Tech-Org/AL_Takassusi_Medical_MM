sap.ui.define([
    "aaml/material/controller/BaseController", "aaml/material/model/models", "sap/m/MessageToast"
], function (BaseController, models, MessageToast) {
    "use strict";

    return BaseController.extend("aaml.material.controller.CasePeriod", {

        onInit: function () {
            this.getView().setModel(models.createPeriodModel(), "view");
            // كل ما الصفحة تتعرض (بما فيها الرجوع من صفحة الـ Cases) بنظبط حالة زرار Clear
            const router = this.getOwnerComponent().getRouter();
            router.getRoute("casePeriod").attachPatternMatched(() => this._reset());
        },

        /** كل Create جديد يبدأ بخانات فاضية. */
        _reset: function () {
            ["dpFrom", "dpTo"].forEach(id => {
                const p = this.byId(id);
                p.setValue("");
                p.setValueState("None");
                p.setValueStateText("");
            });
            this._updateCanClear();
        },

        onBack: function () {
            this.getOwnerComponent().getRouter().navTo("caseSessions");
        },

        /** تغيير أي تاريخ: لو الكتابة غلط بنوري خطأ على الخانة، ولو From بعد To بنوري خطأ على الاتنين. */
        onDateChange: function (oEvent) {
            const picker = oEvent.getSource();
            const valid = oEvent.getParameter("valid") !== false;
            picker.setValueState(valid ? "None" : "Error");
            picker.setValueStateText(valid ? "" : this.getText("invalidDate"));
            if (valid) { this._checkRange(); }
            this._updateCanClear();
        },

        /** Clear يتفعّل لو أي خانة من الاتنين فيها قيمة. */
        _updateCanClear: function () {
            const has = ["dpFrom", "dpTo"].some(id => !!this.byId(id).getValue());
            this.getView().getModel("view").setProperty("/canClear", has);
        },

        /** @returns {boolean} true لو المدى سليم (From <= To). */
        _checkRange: function () {
            const from = this.byId("dpFrom"), to = this.byId("dpTo");
            const bad = !!(from.getValue() && to.getValue() && from.getValue() > to.getValue());
            [from, to].forEach(p => {
                p.setValueState(bad ? "Error" : "None");
                p.setValueStateText(bad ? this.getText("rangeInvalid") : "");
            });
            return !bad;
        },

        /** Get Consumption: بيسجّل المعاملة (أو بيرجّع نفس معاملة الفترة لو اتعملت قبل كده) وبعدين بيفتح Filters + Cases بتاعتها. */
        onGetConsumption: async function () {
            const from = this.byId("dpFrom"), to = this.byId("dpTo");
            const dFrom = from.getValue(), dTo = to.getValue();

            if (!dFrom || !dTo) {
                from.setValueState(dFrom ? "None" : "Error");
                to.setValueState(dTo ? "None" : "Error");
                from.setValueStateText(this.getText("dateRequired"));
                to.setValueStateText(this.getText("dateRequired"));
                return MessageToast.show(this.getText("dateRequired"));
            }
            if (!this._checkRange()) { return MessageToast.show(this.getText("rangeInvalid")); }

            const vm = this.getView().getModel("view");
            vm.setProperty("/busy", true);
            try {
                const session = await this.callAction("openSession", { dateFrom: dFrom, dateTo: dTo });
                this.getOwnerComponent().getRouter().navTo("caseConsumption", { id: session.ID });
            } catch (e) {
                this.showError(e);
            } finally {
                vm.setProperty("/busy", false);
            }
        },

        /** Clear: بيمسح From و To، وبيشيل الـ focus من الزرار عشان أثر الـ hover/focus ما يفضلش (الزرار بيتعطّل). */
        onClear: function (oEvent) {
            ["dpFrom", "dpTo"].forEach(id => {
                const p = this.byId(id);
                p.setValue("");
                p.setValueState("None");
                p.setValueStateText("");
            });
            this._updateCanClear();
            const dom = oEvent.getSource().getDomRef();
            if (dom && dom.blur) { dom.blur(); }
            const inner = dom && dom.querySelector(".sapMBtnInner");
            if (inner && inner.blur) { inner.blur(); }
        }
    });
});