sap.ui.define(["aaml/material/controller/BaseController", "aaml/material/model/models", "aaml/material/model/formatter", "sap/m/MessageBox", "sap/m/MessageToast"],
    function (BaseController, models, formatter, MessageBox, MessageToast) {
        "use strict";

        return BaseController.extend("aaml.material.controller.SharedNursing", {
            // مطلوب عشان الـ View بقى بيستخدم '.formatter.statusState' على عمود الـ Status
            formatter: formatter,

            onInit: async function () {
                const vm = models.createSharedModel();
                this.getView().setModel(vm, "view");
                try {
                    const ctxs = await this.getODataModel().bindList("/HospitalModalities").requestContexts(0, 500);
                    const rows = ctxs.map(c => c.getObject());
                    vm.setProperty("/Pairs", rows);
                    const hs = [...new Set(rows.map(r => r.Hospital))];
                    vm.setProperty("/Hospitals", hs.map(key => ({ key })));
                    if (hs.length === 1) { vm.setProperty("/Hospital", hs[0]); this.onHospitalChange(); }
                } catch (e) { this.showError(e); }
            },
            _vm: function () { return this.getView().getModel("view"); },

            onHospitalChange: function () {
                const vm = this._vm(), hosp = vm.getProperty("/Hospital");
                if (hosp === this._lastHospital) return;        // نفس القيمة: مفيش داعي نفضّي الجدول
                this._lastHospital = hosp;
                const ms = [...new Set(vm.getProperty("/Pairs").filter(p => p.Hospital === hosp).map(p => p.Modality))];
                vm.setProperty("/Modalities", ms.map(key => ({ key })));
                vm.setProperty("/Modality", ""); this._lastModality = ""; this._reset();
                if (ms.length === 1) { vm.setProperty("/Modality", ms[0]); this.onModalityChange(); }   // single option -> auto-select
            },
            onModalityChange: async function () {
                const vm = this._vm();
                const h = vm.getProperty("/Hospital"), m = vm.getProperty("/Modality");
                if (m === this._lastModality) return;           // نفس القيمة: مفيش داعي نفضّي الجدول
                this._lastModality = m; this._reset();
                if (!h || !m) return;
                try {
                    const a = await this.callFunction("deriveSharedAssignment", { hospital: h, modality: m });
                    vm.setProperty("/CostCenter", a.CostCenter || a.Message || ""); vm.setProperty("/Plant", a.Plant || "");
                } catch (e) { this.showError(e); }
            },
            _reset: function () {
                console.debug("[SharedNursing] _reset() -> الجدول اتفضّى. اللي نادى عليها:", new Error().stack);   // للتشخيص: شيله بعد ما نلاقي السبب
                const vm = this._vm(); vm.setProperty("/Items", []); vm.setProperty("/CostCenter", ""); vm.setProperty("/Plant", ""); vm.setProperty("/ClientRequestId", crypto.randomUUID()); },

            /** Search on demand only (>= 2 chars); no full list is preloaded. */
            onSuggest: async function (oEvent) {
                const term = (oEvent.getParameter("suggestValue") || "").trim(), vm = this._vm(), field = oEvent.getSource();
                if (!vm.getProperty("/Plant") || term.length < 2) return;
                try {
                    const r = await this.callFunction("searchNursingMaterials", { term, hospital: vm.getProperty("/Hospital"), modality: vm.getProperty("/Modality") });
                    vm.setProperty("/Suggestions", r.value);
                    field.suggest();                               // re-open the suggestion popup once the async result arrived
                } catch (e) {
                    // البحث بيتنفّذ مع كل حرف: لو فشل طلب مفيش داعي نطلّع MessageBox، بنفضّي الاقتراحات ونكمل
                    vm.setProperty("/Suggestions", []);
                    console.warn("searchNursingMaterials failed for term:", term, e);
                }
            },
            /** Fired by the "search" event: Enter, the search icon, a picked suggestion (param suggestionItem), or the Add button. */
            onAddMaterial: function (oEvent) {
                if (oEvent.getParameter("clearButtonPressed")) return;             // the X button also fires "search"
                const vm = this._vm(), item = oEvent.getParameter("suggestionItem");
                const mat = item ? vm.getProperty(item.getBindingContext("view").getPath()) : (vm.getProperty("/Suggestions") || [])[0];
                if (mat) this._add(mat);
                else MessageToast.show(this.getText("selectMaterialFirst"));       // مفيش مادة مختارة/مقترحة: نوضّح للمستخدم يعمل إيه
            },
            _add: function (mat) {
                const vm = this._vm(); const items = vm.getProperty("/Items") || [];
                // StatusCode = short status (shown as a pill), StatusMessage = details (shown in its own column)
                // بنعمل array جديدة بدل push على نفس الـ array، عشان الـ model يلاحظ التغيير ويرسم كل الصفوف صح
                if (!items.some(i => i.Material === mat.Material)) {
                    vm.setProperty("/Items", [...items, { ...mat, Quantity: "", StatusCode: "", StatusMessage: "" }]);
                }
                vm.setProperty("/Suggestions", []);
                const search = this.byId("matSearch"); search.setValue("");
                search.focus();                                    // الفوكس يرجع لخانة البحث، فزرار Add ما يفضلش "معلّق" بعد الضغط
            },
            onRemove: function (oEvent) {
                const vm = this._vm(); const idx = +oEvent.getSource().getBindingContext("view").getPath().split("/").pop();
                vm.setProperty("/Items", (vm.getProperty("/Items") || []).filter((_, i) => i !== idx));
            },

            onPost: async function () {
                const vm = this._vm(); const d = vm.getData();
                const items = d.Items.filter(i => Number(i.Quantity) > 0).map(i => ({ Material: i.Material, Quantity: Number(i.Quantity), BUOM: i.BUOM }));
                if (!items.length) return MessageToast.show(this.getText("enterQtyFirst"));
                vm.setProperty("/busy", true);
                try {
                    const res = await this.callAction("postShared", { input: { PostingDate: d.PostingDate, Hospital: d.Hospital, Modality: d.Modality, ClientRequestId: d.ClientRequestId, Items: items } });
                    const by = Object.fromEntries((res.Items || []).map(i => [i.Material, i]));
                    vm.setProperty("/Items", d.Items.map(i => {
                        const r = by[i.Material];
                        return r ? { ...i, StatusCode: r.Status || "", StatusMessage: r.Message || "" } : i;
                    }));
                    if (res.Status === "Posted") { MessageBox.success(`SAP document ${res.SAPMaterialDocument}/${res.SAPMaterialDocumentYear}`); vm.setProperty("/ClientRequestId", crypto.randomUUID()); }
                    else MessageBox.warning(res.Message || res.Status);
                } catch (e) { this.showError(e); } finally { vm.setProperty("/busy", false); }
            }
        });
    });