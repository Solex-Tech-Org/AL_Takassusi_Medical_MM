sap.ui.define([
    "aaml/material/controller/BaseController", "aaml/material/model/formatter", "aaml/material/model/models",
    "sap/ui/model/Filter", "sap/ui/model/FilterOperator", "sap/m/MessageBox", "sap/m/MessageToast"
], function (BaseController, formatter, models, Filter, FO, MessageBox, MessageToast) {
    "use strict";

    return BaseController.extend("aaml.material.controller.CaseConsumption", {
        formatter: formatter,

        onInit: function () {
            this.getView().setModel(models.createCaseModel(), "view");

            // الجدول بيبدأ من غير binding؛ بنحتفظ بتعريفه عشان الـ route يربطه بالفترة المختارة كل مرة.
            const table = this.byId("caseTable");
            this._itemsInfo = table.getBindingInfo("items");
            this._itemsInfo.templateShareable = true; // عشان الـ template ما يتمسحش لما نفك الـ binding
            table.unbindItems();

            this._syncSelection();
            this.getOwnerComponent().getRouter().getRoute("caseConsumption").attachPatternMatched(this._onMatched, this);
        },

        /* =========================================================
         * Route: case/session/{id}  (id = معاملة من سجل المعاملات)
         * ========================================================= */

        _onMatched: async function (oEvent) {
            const id = oEvent.getParameter("arguments").id;
            const router = this.getOwnerComponent().getRouter();
            const goBack = () => router.navTo("caseSessions", {}, true);
            if (!/^[0-9a-fA-F-]{36}$/.test(id)) { return goBack(); }

            let session;
            try {
                session = await this.getODataModel().bindContext(`/CaseSessions(${id})`,
                    null, { $select: "ID,SessionNo,DateFrom,DateTo" }).requestObject();
            } catch (e) {
                return goBack();
            }
            if (!session || !session.DateFrom || !session.DateTo) { return goBack(); }

            this._from = session.DateFrom;
            this._to = session.DateTo;
            this.getView().getModel("view").setProperty("/periodText",
                this.getText("periodText", [session.SessionNo, session.DateFrom, session.DateTo]));

            // كل دخول للصفحة = فلاتر فاضية وداتا جديدة للفترة (بنفك الـ binding ونربطه تاني عشان يتحمّل من الأول)
            this._resetFilterFields();
            this._clearSelection();
            this.byId("caseTable").unbindItems();
            this._applyFilters();
        },

        /** زرار Back (فوق على اليمين) والسهم اللي في كارت الفلاتر: الرجوع لسجل المعاملات (الأرقام بتتحدّث بعد أي Post). */
        onBack: function (oEvent) {
            // بنشيل الـ focus/active من الزرار عشان شكله يرجع طبيعي لما نرجع للصفحة دي تاني
            const src = oEvent && oEvent.getSource && oEvent.getSource();
            const dom = src && src.getDomRef && src.getDomRef();
            if (dom && dom.blur) { dom.blur(); }
            const inner = dom && dom.querySelector(".sapMBtnInner");
            if (inner && inner.blur) { inner.blur(); }
            this.getOwnerComponent().getRouter().navTo("caseSessions");
        },

        /* =========================================================
         * Filters
         * ========================================================= */

        _bindItems: function (filters) {
            const i = this._itemsInfo;
            this.byId("caseTable").bindItems({
                path: i.path, parameters: i.parameters, sorter: i.sorter,
                template: i.template, templateShareable: true, filters: filters
            });
        },

        /** كتابة في خانة / تغيير الـ Status: بس بيحدّث حالة زرار Clear (الفلتر نفسه بيتطبق بـ Go أو Enter). */
        onFilterInput: function () { this._updateCanClearFilters(); },

        /** Clear يتفعّل لو أي فلتر فيه قيمة. */
        _updateCanClearFilters: function () {
            const has = ["fHospital", "fModality", "fMaterial"].some(id => !!(this.byId(id).getValue() || "").trim())
                || !!this.byId("fStatus").getSelectedKey();
            this.getView().getModel("view").setProperty("/canClearFilters", has);
        },

        /** Go / Enter: بيطبّق الفلاتر على Cases الفترة المختارة. */
        onSearch: function () {
            // الاختيار القديم ممكن يبقى لصفوف اتشالت من الجدول، فبنصفّره عشان الـ Post ما يبعتش صفوف مش ظاهرة
            this._clearSelection();
            this._applyFilters();
        },

        /** Clear بتاع كارت الفلاتر: بيمسح الفلاتر الأربعة ويرجّع كل Cases الفترة، وبيشيل الـ focus من الزرار. */
        onClearFilters: function (oEvent) {
            this._resetFilterFields();
            this._clearSelection();
            this._applyFilters();
            const dom = oEvent.getSource().getDomRef();
            if (dom && dom.blur) { dom.blur(); }
            const inner = dom && dom.querySelector(".sapMBtnInner");
            if (inner && inner.blur) { inner.blur(); }
        },

        _resetFilterFields: function () {
            ["fHospital", "fModality", "fMaterial"].forEach(id => this.byId(id).setValue(""));
            this.byId("fStatus").setSelectedKey("");
            this._updateCanClearFilters();
        },

        /** الفترة (إجبارية) + باقي الفلاتر (اختيارية) مع بعض بـ AND. Input بيتقرا بـ getValue() و Select بـ getSelectedKey(). */
        _applyFilters: function () {
            const filters = [new Filter("ServiceDate", FO.BT, this._from, this._to)];
            const text = id => (this.byId(id).getValue() || "").trim();

            const hospital = text("fHospital");
            if (hospital) { filters.push(new Filter("Hospital", FO.EQ, hospital)); }
            const modality = text("fModality");
            if (modality) { filters.push(new Filter("Modality", FO.EQ, modality)); }
            const material = text("fMaterial");
            if (material) {
                // كود الخامة أو الوصف يحتوي على النص المكتوب
                filters.push(new Filter({
                    filters: [new Filter("Material", FO.Contains, material), new Filter("MaterialDescription", FO.Contains, material)],
                    and: false
                }));
            }
            const status = this.byId("fStatus").getSelectedKey();
            if (status) { filters.push(new Filter("Status", FO.EQ, status)); }

            const binding = this.byId("caseTable").getBinding("items");
            if (binding) { binding.filter(filters); } else { this._bindItems(filters); }
        },

        onRefresh: function () {
            this._clearSelection();
            const binding = this.byId("caseTable").getBinding("items");
            if (binding) { binding.refresh(); }
        },

        /** Table title shows the total, e.g. "Cases (24)". وبنزامن عداد الاختيار لأن التحديث ممكن يغيّر الصفوف. */
        onTableUpdated: function (oEvent) {
            const total = oEvent.getParameter("total");
            this.byId("caseTableTitle").setText(`${this.getText("caseListTitle")} (${total != null ? total : 0})`);
            this._syncSelection();
            setTimeout(() => this._syncHeaderCheckbox(), 0);
        },

        /* =========================================================
         * Selection
         * ========================================================= */

        /**
         * Only rows with status Ready can be selected.
         * Select All: لو في صفوف متحددة قبل الضغطة = إلغاء الكل، غير كده = تحديد كل الـ Ready.
         */
        onSelectionChange: function (oEvent) {
            const table = this.byId("caseTable");
            const isReady = item => item.getBindingContext().getProperty("Status") === "Ready";

            if (oEvent.getParameter("selectAll")) {
                if (this._hadSelection) {
                    // كان في تحديد قبل الضغطة: المقصود "إلغاء الكل"
                    table.removeSelections(true);
                } else {
                    const items = table.getItems();
                    items.forEach(item => item.setSelected(isReady(item)));
                    if (items.some(item => !isReady(item))) {
                        MessageToast.show(this.getText("onlyReadyRows"));
                    }
                }
            } else {
                // اختيار يدوي: ارفض أي صف مش Ready
                const rejected = oEvent.getParameter("listItems").filter(item =>
                    item.getSelected() && !isReady(item));
                rejected.forEach(item => item.setSelected(false));
                if (rejected.length) { MessageToast.show(this.getText("onlyReadyRows")); }
            }

            this._syncSelection();
            setTimeout(() => this._syncHeaderCheckbox(), 0);
        },

        /** بيحدّث عداد الصفوف المختارة والنص اللي في فوتر الكارت (وبيفعّل/يعطّل زرار Post من view>/selectedCount). */
        _syncSelection: function () {
            const table = this.byId("caseTable");
            const n = table ? table.getSelectedContexts().length : 0;
            this._hadSelection = n > 0; // حالة التحديد قبل الضغطة الجاية على Select All
            const vm = this.getView().getModel("view");
            vm.setProperty("/selectedCount", n);
            vm.setProperty("/selectedText", n ? this.getText("selectedCount", [n]) : this.getText("selectHint"));
        },

        /** checkbox الهيدر متعلّم لما كل الـ Ready متحددة، وفاضي غير كده. */
        _syncHeaderCheckbox: function () {
            const table = this.byId("caseTable");
            if (!table) { return; }
            const ready = table.getItems().filter(i => {
                const ctx = i.getBindingContext();
                return ctx && ctx.getProperty("Status") === "Ready";
            });
            const all = ready.length > 0 && ready.every(i => i.getSelected());

            // الطريقة الأولى: الـ API الداخلي بتاع UI5
            const cb = table._getSelectAllCheckbox && table._getSelectAllCheckbox();
            if (cb) {
                cb.setSelected(all);
                return;
            }
            // احتياطي: ندوّر على الـ checkbox في الـ DOM
            const $cb = table.$().find("thead .sapMCb");
            if ($cb.length && $cb.control(0)) { $cb.control(0).setSelected(all); }
        },

        _clearSelection: function () {
            this.byId("caseTable").removeSelections(true);
            this._syncSelection();
            setTimeout(() => this._syncHeaderCheckbox(), 0);
        },

        /* =========================================================
         * Posting
         * ========================================================= */

        /** تأكيد قبل الترحيل (بيتبعت لـ SAP فمينفعش يتعمل بضغطة غلط). */
        onPost: function () {
            const ctxs = this.byId("caseTable").getSelectedContexts();
            if (!ctxs.length) { return MessageToast.show(this.getText("nothingSelected")); }

            MessageBox.confirm(this.getText("confirmPost", [ctxs.length]), {
                title: this.getText("confirmPostTitle"),
                actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                emphasizedAction: MessageBox.Action.OK,
                onClose: action => { if (action === MessageBox.Action.OK) { this._post(ctxs); } }
            });
        },

        _post: async function (ctxs) {
            const vm = this.getView().getModel("view");
            vm.setProperty("/busy", true);
            try {
                const res = await this.callAction("postSelected", { ids: ctxs.map(c => c.getProperty("ID")) });
                const rows = res.value || [];
                const posted = rows.filter(r => r.Status === "Posted").length;
                const failed = rows.length - posted;
                const lines = rows.map(r => `${r.CaseId}: ${r.Status}${r.SAPMaterialDocument ? " - " + r.SAPMaterialDocument : ""}${r.Message ? " (" + r.Message + ")" : ""}`);
                const text = `${this.getText("postResult", [posted, failed])}\n\n${lines.join("\n")}`;

                (failed ? MessageBox.warning : MessageBox.success)(text);
                this._clearSelection();
                this.byId("caseTable").getBinding("items").refresh();
            } catch (e) {
                this.showError(e);
            } finally {
                vm.setProperty("/busy", false);
            }
        }
    });
});