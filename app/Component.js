sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/Device"
], function (UIComponent, Device) {
  "use strict";

  return UIComponent.extend("aaml.material.Component", {
    metadata: {
      manifest: "json"
    },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
      this.getRouter().initialize();

      // Some controls (NavContainer/ToolPage among them) measure their
      // available size via JS on first render, not just CSS. Inside an
      // embedded preview iframe (e.g. SAP Business Application Studio) that
      // measurement can happen before the iframe itself has a settled
      // height, collapsing content to 0px until something forces a relayout
      // (opening DevTools does this incidentally). Firing a resize shortly
      // after boot forces UI5's own ResizeHandler to recompute, without
      // relying on the user doing that by hand.
      setTimeout(function () {
        window.dispatchEvent(new Event("resize"));
      }, 300);
    }
  });
});
