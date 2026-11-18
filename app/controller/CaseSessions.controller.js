sap.ui.define([
    "aaml/material/controller/BaseController", "aaml/material/model/formatter", "aaml/material/model/models",
    "sap/ui/model/Filter", "sap/ui/model/FilterOperator", "sap/m/MessageBox", "sap/m/MessageToast"
], function (BaseController, formatter, models, Filter, FO, MessageBox, MessageToast) {
    "use strict";

    return BaseController.extend("aaml.material.controller.CaseSessions", {
        formatter: formatter,

        onInit: function () {
            this.getView().setModel(models.createSessionsModel(), "view");
            // الأرقام (Total / Posted / Remaining) بتتغيّر بعد الـ Post، فبنرفرش الجدول كل ما الصفحة تتعرض
            this.refreshOnRoute(["home", "caseSessions"]);
        },

        /** Create: بيفتح صفحة Consumption period (From / To). */
        onCreate: function () {
            this.getOwnerComponent().getRouter().navTo("casePeriod");
        },

        /** Pick an Excel workbook, validate its rows, then let the user review the transaction dates. */
        onImport: function () {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".xlsx,.xls,.csv";
            input.addEventListener("change", async event => {
                const file = event.target.files && event.target.files[0];
                if (!file) { return; }
                try {
                    const xlsx = await this._loadXLSX();
                    const bytes = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = () => reject(new Error("The selected file could not be read."));
                        reader.readAsArrayBuffer(file);
                    });
                    const workbook = xlsx.read(bytes, { type: "array", cellDates: true });
                    this._pendingImport = this._parseImportWorkbook(xlsx, workbook);
                    this.byId("importFileName").setText(file.name);
                    this.byId("importSummary").setText(this.getText("importSummary", [
                        this._pendingImport.rows.length,
                        this._pendingImport.dateFrom,
                        this._pendingImport.dateTo
                    ]));
                    this.byId("importDateFrom").setValue(this._pendingImport.dateFrom);
                    this.byId("importDateTo").setValue(this._pendingImport.dateTo);
                    this.byId("importDialog").open();
                } catch (e) {
                    this.showError(e);
                }
            });
            input.click();
        },

        /** Load the pinned SheetJS build only when an import/export is requested. */
        _loadXLSX: function () {
            if (window.XLSX) { return Promise.resolve(window.XLSX); }
            if (!this._xlsxPromise) {
                this._xlsxPromise = new Promise((resolve, reject) => {
                    const script = document.createElement("script");
                    script.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
                    script.onload = () => {
                        if (window.XLSX) { resolve(window.XLSX); }
                        else { this._xlsxPromise = null; reject(new Error("Excel support could not be loaded.")); }
                    };
                    script.onerror = () => {
                        this._xlsxPromise = null;
                        reject(new Error("Excel support could not be loaded. Check the network connection and try again."));
                    };
                    document.head.appendChild(script);
                });
            }
            return this._xlsxPromise;
        },

        /** Read the first worksheet using the shared import column names. */
        _parseImportWorkbook: function (xlsx, workbook) {
            const sheetName = workbook.SheetNames && workbook.SheetNames[0];
            const sheet = sheetName && workbook.Sheets[sheetName];
            if (!sheet) { throw new Error(this.getText("invalidExcel")); }
            const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "", blankrows: false });
            const headerIndex = matrix.findIndex(row => row.some(cell => String(cell == null ? "" : cell).trim()));
            if (headerIndex < 0) { throw new Error(this.getText("invalidExcel")); }

            const normalize = value => String(value == null ? "" : value).toLowerCase().replace(/[^a-z0-9]/g, "");
            const headers = matrix[headerIndex].map(normalize);
            const aliases = {
                caseId: ["caseid", "case", "procedurekey"],
                serviceDate: ["servicedate", "date", "servicedatetime", "procedureend", "procedureenddate"],
                hospital: ["hospital", "scanhospital"],
                modality: ["modality"],
                risMaterialCode: ["rismaterialcode", "rismaterial", "materialcode", "material"],
                procedureCode: ["procedurecode"],
                quantity: ["quantity", "qty"],
                entryUnit: ["entryunit", "unit", "buom"],
                actualMci: ["actualmci", "mci"]
            };
            const columns = {};
            Object.keys(aliases).forEach(key => {
                // Prefer the most specific alias before generic columns. The workbook has
                // an empty "Material" column before "RIS Material Code"; scanning headers
                // first would incorrectly select the empty Material column for RIS.
                columns[key] = aliases[key]
                    .map(alias => headers.indexOf(alias))
                    .find(index => index >= 0) ?? -1;
            });
            const missing = [];
            if (columns.caseId < 0) { missing.push("Case ID"); }
            if (columns.serviceDate < 0) { missing.push("Service Date"); }
            if (columns.hospital < 0) { missing.push("Hospital"); }
            if (columns.modality < 0) { missing.push("Modality"); }
            if (columns.risMaterialCode < 0) { missing.push("RIS Material Code"); }
            if (columns.procedureCode < 0) { missing.push("Procedure Code"); }
            if (missing.length) { throw new Error(this.getText("missingExcelColumns", [missing.join(", ")])); }

            const cell = (row, key) => columns[key] < 0 ? "" : row[columns[key]];
            const text = value => value == null ? "" : String(value).trim();
            const number = value => {
                if (value == null || value === "") { return null; }
                if (typeof value === "number") { return Number.isFinite(value) ? value : null; }
                const normalized = String(value).trim().replace(/\s/g, "");
                const parsed = Number(normalized.includes(",") && !normalized.includes(".")
                    ? normalized.replace(",", ".") : normalized.replace(/,/g, ""));
                return Number.isFinite(parsed) ? parsed : null;
            };
            const excelDate = value => {
                if (value instanceof Date && !Number.isNaN(value.getTime())) {
                    return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
                }
                if (typeof value === "number") {
                    const parsed = xlsx.SSF.parse_date_code(value, {
                        date1904: !!(workbook.Workbook && workbook.Workbook.WBProps && workbook.Workbook.WBProps.date1904)
                    });
                    if (parsed && parsed.y >= 1900 && parsed.y <= 2100) {
                        return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
                    }
                    return "";
                }
                const valueText = text(value);
                const iso = valueText.match(/^(\d{4})-(\d{2})-(\d{2})/);
                if (iso) {
                    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
                    const parsed = new Date(`${date}T00:00:00.000Z`);
                    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : "";
                }
                const dmy = valueText.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
                if (dmy) {
                    const day = Number(dmy[1]), month = Number(dmy[2]), year = Number(dmy[3]);
                    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
                        const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                        const parsed = new Date(`${date}T00:00:00.000Z`);
                        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : "";
                    }
                }
                return "";
            };

            const rows = [];
            const invalidDates = [];
            matrix.slice(headerIndex + 1).forEach((values, offset) => {
                if (!values.some(value => value != null && String(value).trim() !== "")) { return; }
                const serviceDate = excelDate(cell(values, "serviceDate"));
                if (!serviceDate) {
                    if (invalidDates.length < 20) { invalidDates.push(headerIndex + offset + 2); }
                    return;
                }
                rows.push({
                    CaseId: text(cell(values, "caseId")),
                    ServiceDate: serviceDate,
                    Hospital: text(cell(values, "hospital")),
                    Modality: text(cell(values, "modality")),
                    RISMaterialCode: text(cell(values, "risMaterialCode")) || null,
                    ProcedureCode: text(cell(values, "procedureCode")) || null,
                    Quantity: number(cell(values, "quantity")),
                    EntryUnit: text(cell(values, "entryUnit")) || null,
                    ActualMci: number(cell(values, "actualMci"))
                });
            });
            if (invalidDates.length) {
                throw new Error(this.getText("invalidExcelDates", [invalidDates.join(", ")]));
            }
            if (!rows.length) { throw new Error(this.getText("invalidExcel")); }
            if (rows.length > 5000) { throw new Error(this.getText("excelRowLimit")); }
            const dates = rows.map(row => row.ServiceDate).sort();
            return { rows: rows, dateFrom: dates[0], dateTo: dates[dates.length - 1] };
        },

        /** Create or reuse the matching session and run rows through the existing RIS calculation path. */
        onConfirmImport: async function () {
            if (!this._pendingImport) { return; }
            const dateFrom = this.byId("importDateFrom").getValue();
            const dateTo = this.byId("importDateTo").getValue();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) {
                return MessageToast.show(this.getText("rangeInvalid"));
            }
            const outside = this._pendingImport.rows.some(row => row.ServiceDate < dateFrom || row.ServiceDate > dateTo);
            if (outside) { return MessageBox.error(this.getText("importDateRangeError")); }

            const vm = this.getView().getModel("view");
            vm.setProperty("/busy", true);
            try {
                const result = await this.callAction("importCaseConsumption", {
                    dateFrom: dateFrom,
                    dateTo: dateTo,
                    rows: this._pendingImport.rows
                });
                this.byId("importDialog").close();
                this._pendingImport = null;
                MessageToast.show(this.getText("importSuccess", [result.ImportedCount, result.DuplicateCount, result.ReadyCount, result.BlockedCount]));
                if (result.ID) {
                    this.getOwnerComponent().getRouter().navTo("caseConsumption", { id: result.ID });
                }
            } catch (e) {
                this.showError(e);
            } finally {
                vm.setProperty("/busy", false);
            }
        },

        onCancelImport: function () {
            this._pendingImport = null;
            this.byId("importDialog").close();
        },

        /** Export every transaction and its source/calculated case rows to a two-sheet workbook. */
        onExport: async function () {
            const vm = this.getView().getModel("view");
            vm.setProperty("/busy", true);
            try {
                const xlsx = await this._loadXLSX();
                await this.callAction("refreshSapDocumentItems", {});
                const model = this.getODataModel();
                const sessions = await this._readAll(model, "/CaseSessions",
                    "ID,SessionNo,DateFrom,DateTo,createdAt,TotalCases,PostedCases,RemainingCases,SessionStatus");
                const cases = await this._readAll(model, "/ConsumptionTechnical",
                    "CaseId,ProcedureCode,RISMaterialCode,ServiceDate,Material,MaterialDescription,MaterialClass,Quantity,EntryUnit,ActualMci,PostingQuantity,PostingUnit,MaximumMciPerVial,CalculatedVials,Batch,BatchDetails,EstimatedWaste,Plant,StorageLocation,Status,ErrorMessage,SAPMaterialDocument,SAPMaterialDocumentYear,SAPMaterialDocumentItem",
                    { $expand: "Hospital($select=Code),Modality($select=Code),BatchAllocations($select=Sequence,SAPMaterialDocumentItem)" });
                if (!sessions.length && !cases.length) { return MessageToast.show(this.getText("exportNoData")); }

                const sessionForDate = date => sessions.find(session => date >= session.DateFrom && date <= session.DateTo);
                const caseHeaders = [
                    "Transaction ID", "Case ID", "Service Date", "Hospital", "Modality", "Material", "RIS Material Code", "Procedure Code",
                    "Material Description", "Material Class", "Quantity", "Entry Unit", "Actual mCi", "Posting Quantity", "Posting Unit",
                    "Maximum mCi per Vial", "Calculated Vials", "Batch", "Batch Details", "Estimated Waste", "Plant", "Storage Location",
                    "Status", "Message", "SAP Material Document", "SAP Document Year", "SAP Document Item"
                ];
                const caseRows = cases.map(row => {
                    const session = sessionForDate(row.ServiceDate || "");
                    return {
                        "Transaction ID": session ? session.SessionNo : "",
                        "Case ID": row.CaseId,
                        "Service Date": row.ServiceDate,
                        "Hospital": row.Hospital?.Code || row.Hospital_Code || "",
                        "Modality": row.Modality?.Code || row.Modality_Code || "",
                        "Material": row.Material,
                        "RIS Material Code": row.RISMaterialCode,
                        "Procedure Code": row.ProcedureCode,
                        "Material Description": row.MaterialDescription,
                        "Material Class": row.MaterialClass,
                        "Quantity": row.Quantity,
                        "Entry Unit": row.EntryUnit,
                        "Actual mCi": row.ActualMci,
                        "Posting Quantity": row.PostingQuantity,
                        "Posting Unit": row.PostingUnit,
                        "Maximum mCi per Vial": row.MaximumMciPerVial,
                        "Calculated Vials": row.CalculatedVials,
                        "Batch": row.Batch,
                        "Batch Details": row.BatchDetails,
                        "Estimated Waste": row.EstimatedWaste,
                        "Plant": row.Plant,
                        "Storage Location": row.StorageLocation,
                        "Status": row.Status,
                        "Message": row.ErrorMessage,
                        "SAP Material Document": row.SAPMaterialDocument,
                        "SAP Document Year": row.SAPMaterialDocumentYear,
                        "SAP Document Item": this._sapDocumentItems(row)
                    };
                });
                const transactionHeaders = ["Transaction ID", "From", "To", "Created", "Total cases", "Posted", "Remaining", "Status"];
                const transactionRows = sessions.map(session => ({
                    "Transaction ID": session.SessionNo,
                    "From": session.DateFrom,
                    "To": session.DateTo,
                    "Created": session.createdAt,
                    "Total cases": session.TotalCases,
                    "Posted": session.PostedCases,
                    "Remaining": session.RemainingCases,
                    "Status": session.SessionStatus
                }));
                const workbook = xlsx.utils.book_new();
                const caseData = [caseHeaders, ...caseRows.map(row => caseHeaders.map(header => row[header] == null ? "" : row[header]))];
                const transactionData = [transactionHeaders, ...transactionRows.map(row => transactionHeaders.map(header => row[header] == null ? "" : row[header]))];
                xlsx.utils.book_append_sheet(workbook,
                    xlsx.utils.aoa_to_sheet(caseData), "Cases");
                xlsx.utils.book_append_sheet(workbook,
                    xlsx.utils.aoa_to_sheet(transactionData), "Transactions");
                const today = new Date().toISOString().slice(0, 10);
                xlsx.writeFile(workbook, `AAML_Material_Consumption_${today}.xlsx`);
                MessageToast.show(this.getText("exportSuccess", [sessions.length, cases.length]));
            } catch (e) {
                this.showError(e);
            } finally {
                vm.setProperty("/busy", false);
            }
        },

        _sapDocumentItems: function (row) {
            const allocations = Array.isArray(row.BatchAllocations) ? row.BatchAllocations : [];
            const allocationItems = allocations
                .map(allocation => String(allocation.SAPMaterialDocumentItem || "").trim())
                .filter(Boolean);
            const detailItems = [...String(row.BatchDetails || "").matchAll(/\bSAP item\s+([^\s]+)/gi)]
                .map(match => match[1]);
            const storedItem = String(row.SAPMaterialDocumentItem || "").trim();
            const sourceItems = allocationItems.length ? allocationItems : detailItems.length ? detailItems : storedItem ? [storedItem] : [];
            const items = [...new Set(sourceItems)]
                .sort((left, right) => Number(left) - Number(right));
            return items.length ? items.join(", ") : row.SAPMaterialDocumentItem;
        },

        _readAll: async function (model, path, select, queryOptions = {}) {
            const binding = model.bindList(path, null, [], [], { $select: select, ...queryOptions });
            const rows = [];
            const pageSize = 500;
            try {
                for (let offset = 0; ; offset += pageSize) {
                    const contexts = await binding.requestContexts(offset, pageSize);
                    rows.push(...contexts.map(context => context.getObject()));
                    if (contexts.length < pageSize) { break; }
                }
            } finally {
                binding.destroy();
            }
            return rows;
        },

        /** الضغط على معاملة سابقة: بيفتح Cases بتاعة نفس الفترة (اللي لسه ما اتعملهاش Post). */
        onSessionPress: function (oEvent) {
            const id = oEvent.getSource().getBindingContext().getProperty("ID");
            this.getOwnerComponent().getRouter().navTo("caseConsumption", { id: id });
        },

        /** Delete a period and its unposted cases after an explicit confirmation. */
        onDeleteSession: function (oEvent) {
            const session = oEvent.getSource().getBindingContext().getObject();
            if (Number(session.PostedCases || 0) > 0) {
                return MessageBox.error(this.getText("deleteSessionBlocked"));
            }
            const deleteAction = this.getText("deleteSessionAction");
            MessageBox.warning(this.getText("confirmDeleteSession", [
                session.SessionNo, session.DateFrom, session.DateTo
            ]), {
                title: this.getText("deleteSessionTitle"),
                actions: [deleteAction, MessageBox.Action.CANCEL],
                emphasizedAction: deleteAction,
                onClose: action => {
                    if (action === deleteAction) { this._deleteSession(session); }
                }
            });
        },

        _deleteSession: async function (session) {
            if (this._deletingSessionId) { return; }
            this._deletingSessionId = session.ID;
            try {
                const result = await this.callAction("deleteSession", { ID: session.ID });
                MessageToast.show(this.getText("deleteSessionSuccess", [result.SessionNo, result.DeletedCases]));
                const binding = this.byId("sessionsTable").getBinding("items");
                if (binding) { binding.refresh(); }
            } catch (e) {
                this.showError(e);
            } finally {
                this._deletingSessionId = null;
            }
        },

        /* ---------------- Filters: Transaction ID + تاريخ ---------------- */

        /** Clear يتفعّل لو أي فلتر فيه قيمة. */
        onFilterInput: function () {
            const has = !!(this.byId("fSessionNo").getValue() || "").trim() || !!this.byId("fDate").getValue();
            this.getView().getModel("view").setProperty("/canClear", has);
        },

        /** Go / Enter: الـ ID بـ Contains (مش حساس لحالة الحروف)، والتاريخ بيجيب أي معاملة فترتها بتشمل اليوم ده. */
        onSearch: function () {
            const filters = [];
            const no = (this.byId("fSessionNo").getValue() || "").trim();
            const date = this.byId("fDate").getValue();
            if (no) { filters.push(new Filter({ path: "SessionNo", operator: FO.Contains, value1: no, caseSensitive: false })); }
            if (date) {
                filters.push(new Filter("DateFrom", FO.LE, date));
                filters.push(new Filter("DateTo", FO.GE, date));
            }
            const binding = this.byId("sessionsTable").getBinding("items");
            if (binding) { binding.filter(filters.length ? new Filter({ filters: filters, and: true }) : []); }
        },

        /** Clear: بيمسح الفلاتر ويرجّع كل المعاملات، وبيشيل الـ focus من الزرار. */
        onClearFilters: function (oEvent) {
            this.byId("fSessionNo").setValue("");
            this.byId("fDate").setValue("");
            this.onFilterInput();
            this.onSearch();
            const dom = oEvent.getSource().getDomRef();
            if (dom && dom.blur) { dom.blur(); }
            const inner = dom && dom.querySelector(".sapMBtnInner");
            if (inner && inner.blur) { inner.blur(); }
        },

        onRefresh: function () {
            const binding = this.byId("sessionsTable").getBinding("items");
            if (binding) { binding.refresh(); }
        },

        onTableUpdated: function (oEvent) {
            const total = oEvent.getParameter("total");
            this.byId("sessionsTitle").setText(`${this.getText("sessionsTitle")} (${total != null ? total : 0})`);
        }
    });
});
