sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {
    "use strict";

    // nav item key -> route name
    const ROUTES = { case: "caseSessions", shared: "sharedNursing", report: "materialReport" };
    // route name -> nav item key
    const KEYS = { home: "case", caseSessions: "case", casePeriod: "case", caseConsumption: "case", sharedNursing: "shared", materialReport: "report" };

    return Controller.extend("aaml.material.controller.App", {
        onInit: function () {
            this.getOwnerComponent().getRouter().attachRouteMatched(this._onRouteMatched, this);
        },

        _onRouteMatched: function (oEvent) {
            const key = KEYS[oEvent.getParameter("name")];
            const nav = this.byId("sideNav");
            if (nav && key) { nav.setSelectedKey(key); }
        },

        onNavItemSelect: function (oEvent) {
            const route = ROUTES[oEvent.getParameter("item").getKey()];
            if (route) { this.getOwnerComponent().getRouter().navTo(route); }
        },

        onToggleSideNav: function () {
            const page = this.byId("toolPage");
            page.setSideExpanded(!page.getSideExpanded());
        }
    });
});