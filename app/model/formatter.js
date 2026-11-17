sap.ui.define([], function () {
    "use strict";
    const CLASS = { Normal: "Normal", NuclearLiquid: "NM Liquid", NuclearPowder: "NM Powder", NursingShared: "Nursing" };
    const STATE = {
        Ready: "Success", Posted: "Success", Success: "Success", Blocked: "Error", NeedsCorrection: "Error", Error: "Error", BusinessError: "Error", TechnicalError: "Error",
        Reversed: "Warning", Pending: "Warning", Received: "Information", Open: "Warning", Completed: "Success"
    };
    return {
        classText: c => CLASS[c] || c || "",
        qtyUnit: (q, u) => (q == null ? "" : `${Number(q)} ${u || ""}`.trim()),
        num3: v => (v == null ? "" : Number(v).toFixed(3)),
        waste: (cls, v) => (v == null ? (cls === "NuclearLiquid" ? "At close" : "") : `${Number(v).toFixed(3)} Vial`),
        dateTime: v => {
            if (!v) { return ""; }
            const d = new Date(v);
            return isNaN(d.getTime()) ? String(v) : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
        },
        codeDescription: (code, options) => {
            const item = Array.isArray(options) && options.find(option => String(option.key) === String(code));
            return item ? item.text : (code || "-");
        },
        hospMod: (h, m, hospitals, modalities) => {
            const label = (code, options) => {
                const item = Array.isArray(options) && options.find(option => String(option.key) === String(code));
                return item ? item.text : (code || "-");
            };
            return `${label(h, hospitals)} / ${label(m, modalities)}`;
        },
        plantSloc: (p, s) => `${p || "-"} / ${s || "-"}`,
        batchRule: (c, batch) => (c === "NuclearLiquid" ? "Service date" : (c === "NuclearPowder" || batch) ? "FEFO" : "-"),
        capacity: v => (v == null ? "-" : `${Number(v)} mCi/Vial`),
        // Nuclear: "12 / 50 = 0.240 Vial"  |  Normal: "2 EA"
        postingQty: (cls, q, u, mci, cap, vials, postingQuantity, postingUnit) => {
            const nuclear = cls === "NuclearLiquid" || cls === "NuclearPowder";
            if (nuclear && mci != null && cap != null && vials != null) { return `${Number(mci)} / ${Number(cap)} = ${Number(vials).toFixed(3)} Vial`; }
            const quantity = postingQuantity == null ? q : postingQuantity;
            const unit = postingUnit || u;
            return quantity == null ? "-" : `${Number(quantity)} ${unit || ""}`.trim();
        },
        statusState: s => STATE[s] || "None",
        sapDoc: (d, y, i) => (d ? `${d}/${y || ""}${i ? "/" + i : ""}` : "")
    };
});
