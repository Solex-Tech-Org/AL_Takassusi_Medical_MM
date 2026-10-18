sap.ui.define(["aaml/material/controller/BaseController", "aaml/material/model/formatter", "sap/ui/model/Filter", "sap/ui/model/FilterOperator"],
    function (BaseController, formatter, Filter, FO) {
        "use strict";

        // [input id, OData property, operator]
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

            onInit: function () { this.refreshOnRoute(["materialReport"]); },

            onFilter: function () {
                const f = [];
                FILTERS.forEach(([id, path, op]) => {
                    const v = this.byId(id).getValue().trim();
                    if (v) { f.push(new Filter(path, op, v)); }
                });
                this.byId("historyTable").getBinding("items").filter(f);
            },

            onClearFilters: function () {
                FILTERS.forEach(([id]) => this.byId(id).setValue(""));
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