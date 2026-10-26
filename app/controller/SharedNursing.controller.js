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

            /** يرجّع نتايج البحث (>= 2 حرف) ويحدّث /Suggestions. بيتجاهل أي رد أقدم من آخر طلب. */
            _search: async function (term) {
                const vm = this._vm();
                term = (term || "").trim();
                if (term.length < 2) { vm.setProperty("/Suggestions", []); return []; }
                const reqId = this._searchReq = (this._searchReq || 0) + 1;
                const r = await this.callFunction("searchNursingMaterials", { term, hospital: vm.getProperty("/Hospital"), modality: vm.getProperty("/Modality") });
                const rows = Array.isArray(r) ? r : (r && r.value) || [];
                if (reqId === this._searchReq) vm.setProperty("/Suggestions", rows);   // رد قديم ما يكتبش فوق الأحدث
                return rows;
            },

            /** Search on demand only (>= 2 chars); no full list is preloaded. */
            onSuggest: async function (oEvent) {
                const field = oEvent.getSource();
                const term = oEvent.getParameter("suggestValue") || field.getValue();   // fallback لكيبورد الموبايل
                try {
                    await this._search(term);
                    if (field.getDomRef() || field.getParent()) field.suggest();       // re-open the suggestion popup once the async result arrived
                } catch (e) {
                    this._vm().setProperty("/Suggestions", []);
                    console.warn("searchNursingMaterials failed for term:", term, e);
                    MessageToast.show(e && e.message ? e.message : this.getText("selectMaterialFirst"));
                }
            },

            /** Fired by the "search" event: Enter, the search icon, a picked suggestion (param suggestionItem), or the Add button. */
            onAddMaterial: async function (oEvent) {
                if (oEvent.getParameter && oEvent.getParameter("clearButtonPressed")) return;   // the X button also fires "search"
                const vm = this._vm(), field = this.byId("matSearch");
                const item = oEvent.getParameter && oEvent.getParameter("suggestionItem");
                let mat;
                if (item) {
                    mat = vm.getProperty(item.getBindingContext("view").getPath());
                } else {
                    const typed = (field.getValue() || "").trim();
                    let rows = vm.getProperty("/Suggestions") || [];
                    if (!rows.length && typed.length >= 2) {        // مفيش اقتراحات (غالبًا موبايل): ابحث دلوقتي بالنص المكتوب
                        try { rows = await this._search(typed); }
                        catch (e) { this.showError(e); return; }
                    }
                    mat = rows.find(r => String(r.Material) === typed) || rows[0];   // كود مطابق بالظبط، وإلا أول نتيجة
                }
                if (mat) this._add(mat);
                else MessageToast.show(this.getText("selectMaterialFirst"));       // مفيش مادة مختارة/مقترحة: نوضّح للمستخدم يعمل إيه
            },
            _add: function (mat) {
                const vm = this._vm(); const items = vm.getProperty("/Items") || [];
                // StatusCode = short status (shown as a pill), StatusMessage = details (shown in its own column)
                // بنعمل array جديدة بدل push على نفس الـ array، عشان الـ model يلاحظ التغيير ويرسم كل الصفوف صح
                if (!items.some(i => i.Material === mat.Material)) {
                    const noStock = mat.Available !== null && mat.Available !== undefined && !(Number(mat.Available) > 0);   // Available = 0: qty input is locked (see view)
                    vm.setProperty("/Items", [...items, { ...mat, Quantity: "", StatusCode: noStock ? "Error" : "", StatusMessage: noStock ? this.getText("noStock") : "",
                        QtyState: "None", QtyStateText: "" }]);
                }
                vm.setProperty("/Suggestions", []);
                const search = this.byId("matSearch"); search.setValue("");
                if (!sap.ui.Device.system.phone) search.focus();   // على الموبايل الفوكس بيفتح الكيبورد تاني؛ الفوكس يرجع لخانة البحث، فزرار Add ما يفضلش "معلّق" بعد الضغط
            },
            /** null = OK, otherwise the error text. Empty/0 qty is not an error (it is simply not posted). Available = null (no Hospital/Modality yet) is left to the backend. */
            _qtyError: function (item, qty) {
                const q = Number(qty);
                if (!(q > 0) || item.Available === null || item.Available === undefined) return null;
                const avail = Number(item.Available);
                if (!(avail > 0)) return this.getText("noStock");
                if (q > avail) return this.getText("qtyExceedsStock", [avail]);
                return null;
            },
            /** Live feedback while typing: red border + message under the field when qty > Available. */
            onQtyChange: function (oEvent) {
                const vm = this._vm(), path = oEvent.getSource().getBindingContext("view").getPath();
                const err = this._qtyError(vm.getProperty(path), oEvent.getParameter("value"));
                vm.setProperty(path + "/QtyState", err ? "Error" : "None");
                vm.setProperty(path + "/QtyStateText", err || "");
            },
            /** After a successful post the stock changed: re-read Available so the same stock cannot be posted twice. */
            _refreshAvailable: async function () {
                const vm = this._vm(), h = vm.getProperty("/Hospital"), m = vm.getProperty("/Modality");
                const items = vm.getProperty("/Items") || [];
                const fresh = await Promise.all(items.map(async i => {
                    try {
                        const r = await this.callFunction("searchNursingMaterials", { term: i.Material, hospital: h, modality: m });
                        const rows = Array.isArray(r) ? r : (r && r.value) || [];
                        const f = rows.find(x => x.Material === i.Material);
                        return f ? { ...i, Available: f.Available } : i;
                    } catch (e) { return i; }
                }));
                vm.setProperty("/Items", fresh);
            },
            onRemove: function (oEvent) {
                const vm = this._vm(); const idx = +oEvent.getSource().getBindingContext("view").getPath().split("/").pop();
                vm.setProperty("/Items", (vm.getProperty("/Items") || []).filter((_, i) => i !== idx));
            },

            onPost: async function () {
                const vm = this._vm(); const d = vm.getData();
                const items = d.Items.filter(i => Number(i.Quantity) > 0).map(i => ({ Material: i.Material, Description: i.Description, Quantity: Number(i.Quantity), BUOM: i.BUOM }));
                if (!items.length) return MessageToast.show(this.getText("enterQtyFirst"));
                // client-side guard (the backend re-checks anyway): Available = 0 or Quantity > Available -> do not post
                const errs = d.Items.map(i => (Number(i.Quantity) > 0 ? this._qtyError(i, i.Quantity) : null));
                if (errs.some(Boolean)) {
                    vm.setProperty("/Items", d.Items.map((i, n) => errs[n]
                        ? { ...i, StatusCode: "Error", StatusMessage: errs[n], QtyState: "Error", QtyStateText: errs[n] } : i));
                    return MessageBox.error(this.getText("fixQtyFirst"));
                }
                vm.setProperty("/busy", true);
                try {
                    const res = await this.callAction("postShared", { input: { PostingDate: d.PostingDate, Hospital: d.Hospital, Modality: d.Modality, ClientRequestId: d.ClientRequestId, Items: items } });
                    const by = Object.fromEntries((res.Items || []).map(i => [i.Material, i]));
                    vm.setProperty("/Items", d.Items.map(i => {
                        const r = by[i.Material];
                        return r ? { ...i, StatusCode: r.Status || "", StatusMessage: r.Message || "" } : i;
                    }));
                    if (res.Status === "Posted") { MessageBox.success(`SAP document ${res.SAPMaterialDocument}/${res.SAPMaterialDocumentYear}`); vm.setProperty("/ClientRequestId", crypto.randomUUID()); await this._refreshAvailable(); }
                    else MessageBox.warning(res.Message || res.Status);
                } catch (e) { this.showError(e); } finally { vm.setProperty("/busy", false); }
            }
        });
    });