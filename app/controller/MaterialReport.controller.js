sap.ui.define(["aaml/material/controller/BaseController", "aaml/material/model/formatter", "sap/ui/model/Filter", "sap/ui/model/FilterOperator", "sap/ui/model/json/JSONModel"],
    function (BaseController, formatter, Filter, FO, JSONModel) {
        "use strict";

        // [control id, OData property, operator]
        const FILTERS = [
            ["rDate", "ServiceDate", FO.EQ],
            ["rHospital", "Hospital", FO.EQ],
            ["rModality", "Modality", FO.EQ],
            ["rCase", "CaseId", FO.EQ],
            ["rMaterial", "Material", FO.Contains],
            ["rStatus", "Status", FO.EQ],
            ["rSap", "SAPMaterialDocument", FO.EQ]
        ];

        return BaseController.extend("aaml.material.controller.MaterialReport", {
            formatter: formatter,

            onInit: function () {
                this.getView().setModel(new JSONModel({ HospitalFilter: "", ModalityFilter: "", Hospitals: [], Modalities: [] }), "view");
                this.refreshOnRoute(["materialReport"]);
                this._loadCodeLists();
            },

            _loadCodeLists: async function () {
                try {
                    const model = this.getODataModel();
                    const [hospitalContexts, modalityContexts] = await Promise.all([
                        model.bindList("/Hospitals").requestContexts(0, 500),
                        model.bindList("/Modalities").requestContexts(0, 500)
                    ]);
                    const options = contexts => contexts.map(context => context.getObject())
                        .sort((a, b) => Number(a.SortOrder || 0) - Number(b.SortOrder || 0))
                        .map(row => {
                        return { key: row.Code, text: `${row.Code} - ${row.Description}` };
                    });
                    const vm = this.getView().getModel("view");
                    vm.setProperty("/Hospitals", options(hospitalContexts));
                    vm.setProperty("/Modalities", options(modalityContexts));
                } catch (e) { this.showError(e); }
            },

            onFilter: function () {
                const f = [];
                FILTERS.forEach(([id, path, op]) => {
                    const control = this.byId(id);
                    const v = control.getSelectedKey ? control.getSelectedKey() : control.getValue().trim();
                    if (v) { f.push(new Filter(path, op, v)); }
                });
                this.byId("historyTable").getBinding("items").filter(f);
            },

            onClearFilters: function () {
                FILTERS.forEach(([id]) => {
                    const control = this.byId(id);
                    if (control.setSelectedKey) { control.setSelectedKey(""); }
                    else { control.setValue(""); }
                });
                this.byId("historyTable").getBinding("items").filter([]);
            },

            /** Reload the tables of this view (the refresh button in each card header). */
            onRefresh: function () { this.refreshLists(); },

            /** Show the row count next to the card title, e.g. "History (24)". */
            onTableUpdated: function (e) {
                const table = e.getSource();
                const toolbar = table.getHeaderToolbar();
                const key = table.data("titleKey");
                const total = e.getParameter("total");
                if (!toolbar || !key) { return; }
                const title = toolbar.getContent()[0];
                const base = this.getText(key);
                title.setText(typeof total === "number" && total >= 0 ? `${base} (${total})` : base);
            }
        });
    });
