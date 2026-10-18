sap.ui.define(["sap/ui/core/mvc/Controller", "sap/m/MessageBox"], function (Controller, MessageBox) {
    "use strict";
    return Controller.extend("aaml.material.controller.BaseController", {
        /** OData model. The view is not attached to the component yet inside onInit, so fall back to the owner component's model. */
        getODataModel: function () { return this.getView().getModel() || this.getOwnerComponent().getModel(); },

        /** Re-request every table bound in this view, so data posted elsewhere shows up without a browser refresh. */
        refreshLists: function () {
            this.getView().findAggregatedObjects(true, c => c.isA("sap.m.ListBase")).forEach(list => {
                const b = list.getBinding("items");
                if (b) { b.refresh(); }
            });
        },

        /** Refresh this view's tables each time one of the given routes is displayed (views are cached by the NavContainer). */
        refreshOnRoute: function (routeNames) {
            const router = this.getOwnerComponent().getRouter();
            routeNames.forEach(n => router.getRoute(n).attachPatternMatched(() => this.refreshLists()));
        },

        getText: function (key, args) { return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(key, args); },

        /** Call an unbound OData V4 action; resolves to the result object. */
        callAction: async function (name, params) {
            const op = this.getODataModel().bindContext(`/${name}(...)`);
            Object.entries(params).forEach(([k, v]) => op.setParameter(k, v));
            await op.execute();
            return op.getBoundContext().getObject();
        },

        /** Call an unbound OData V4 function. */
        callFunction: function (name, params) {
            const q = Object.entries(params).map(([k, v]) => `${k}=${typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : v}`).join(",");
            return this.getODataModel().bindContext(`/${name}(${q})`).requestObject();
        },

        showError: function (e) { MessageBox.error(e && e.message ? e.message : String(e)); }
    });
});
