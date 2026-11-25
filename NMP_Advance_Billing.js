/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Item Fulfillment -> Auto Invoice (+ Advance Billing COGS JE / reversal)
 * Flat Rate rule: SO line with Rate = 0 and Amount > 0 is billed for its FULL
 * SO quantity and FULL amount on the first invoice (whatever qty was fulfilled).
 * The SO line is then fully billed, so later transforms simply won't bring it in.
 *
 * + Automated invoice email: after the invoice is created, starts the
 *   "Invoice Email Automation" workflow, which sends the email.
 */
define(['N/record', 'N/search', 'N/runtime', 'N/log', 'N/workflow'],
    (record, search, runtime, log, workflow) => {

    const INVOICE_EMAIL_WORKFLOW = 'customworkflow_invoice_email_automation';

    /* ===================== NEW: IF DETAILS ON INVOICE (Ship To, Lot, Expiry) ===================== */
    const ADDRESS_FIELDS = ['country', 'attention', 'addressee', 'addrphone', 'addr1', 'addr2', 'addr3', 'city', 'state', 'zip'];

    // Ship To address from the IF (null if none)
    const getIfShipAddress = (ff) => {
        try {
            const sub = ff.getSubrecord({ fieldId: 'shippingaddress' });
            const a = {};
            ADDRESS_FIELDS.forEach((f) => { a[f] = sub.getValue({ fieldId: f }) || ''; });
            return (a.addr1 || a.city) ? a : null;
        } catch (e) {
            log.error('IF Ship Address Read Failed', e.message);
            return null;
        }
    };

    // Copy IF Ship To onto the invoice (country first - it changes the address form)
    const setInvoiceShipAddress = (invoice, a) => {
        if (!a) return;
        try {
            const sub = invoice.getSubrecord({ fieldId: 'shippingaddress' });
            sub.setValue({ fieldId: 'country', value: a.country });
            ADDRESS_FIELDS.slice(1).forEach((f) => sub.setValue({ fieldId: f, value: a[f] }));
            log.audit('Ship To Copied From IF', a);
        } catch (e) {
            log.error('Ship To Copy Failed (invoice keeps SO address)', e.message);
        }
    };

    // Lots on the IF grouped by SO line: { orderline: [{ numberId, number, qty, expiry }] }
    const getIfLots = (ff) => {
        const byLine = {};
        const ids = {};
        for (let i = 0; i < ff.getLineCount({ sublistId: 'item' }); i++) {
            const orderline = String(ff.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i }));
            const qty = +ff.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }) || 0;
            if (!orderline || qty <= 0) continue;
            if (!ff.hasSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line: i })) continue;

            const detail = ff.getSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line: i });
            for (let j = 0; j < detail.getLineCount({ sublistId: 'inventoryassignment' }); j++) {
                const numberId = detail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'issueinventorynumber', line: j });
                const lotQty = +detail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: j }) || 0;
                if (!numberId || lotQty <= 0) continue;

                const list = byLine[orderline] || (byLine[orderline] = []);
                const same = list.find((l) => l.numberId === String(numberId));
                if (same) same.qty += lotQty;
                else list.push({ numberId: String(numberId), qty: lotQty, number: '', expiry: '' });
                ids[numberId] = true;
            }
        }

        // Lot number text + expiry date (one search)
        const idList = Object.keys(ids);
        if (idList.length) {
            const info = {};
            search.create({
                type: search.Type.INVENTORY_NUMBER,
                filters: [['internalid', 'anyof', idList]],
                columns: ['inventorynumber', 'expirationdate']
            }).run().each((r) => {
                info[r.id] = { number: r.getValue('inventorynumber'), expiry: r.getValue('expirationdate') };
                return true;
            });
            Object.keys(byLine).forEach((ol) => byLine[ol].forEach((l) => {
                if (info[l.numberId]) { l.number = info[l.numberId].number; l.expiry = info[l.numberId].expiry; }
            }));
        }
        return byLine;
    };

    // Replace invoice line Inventory Detail with the IF lots (expiry comes with the lot).
    // Only if the line already has Inventory Detail and lot qty total = invoice line qty.
    const setInvoiceLineLots = (invoice, i, lots, lineQty, orderline) => {
        if (!invoice.hasSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line: i })) {
            return log.audit('Invoice Line Has No Inventory Detail (skipped)', { orderline });
        }
        const lotTotal = lots.reduce((s, l) => s + l.qty, 0);
        if (Math.abs(lotTotal - lineQty) > 0.00001) {
            return log.audit('Inventory Detail Skipped - lot qty differs from invoice qty', { orderline, lineQty, lotTotal });
        }

        const detail = invoice.getSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line: i });
        for (let j = detail.getLineCount({ sublistId: 'inventoryassignment' }) - 1; j >= 0; j--) {
            detail.removeLine({ sublistId: 'inventoryassignment', line: j });
        }
        lots.forEach((l, j) => {
            detail.insertLine({ sublistId: 'inventoryassignment', line: j });
            detail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'issueinventorynumber', line: j, value: l.numberId });
            detail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: j, value: l.qty });
        });
        log.audit('Lots Copied From IF', { orderline, lots });
    };
    /* ============================================================================================= */

    const afterSubmit = (context) => {
        try {
            const T = context.UserEventType;
            if (![T.CREATE, T.EDIT, T.PACK, T.SHIP].includes(context.type)) return;

            log.audit('Script Triggered', { event: context.type, fulfillmentId: context.newRecord.id });

            const ff = record.load({ type: record.Type.ITEM_FULFILLMENT, id: context.newRecord.id });
            const soId = ff.getValue('createdfrom');
            if (!soId) return log.audit('Script Stopped', 'No Sales Order linked');

            const advance = ff.getValue('custbody_advance_billing');
            const shipped = ff.getValue('shipstatus') === 'C';
            const ifNumber = ff.getValue('tranid');

            // Customer checkbox only matters for normal (non-advance) billing
            if (!advance) {
                const customerAdvance = shipped && search.lookupFields({
                    type: search.Type.CUSTOMER,
                    id: ff.getValue('entity'),
                    columns: ['custentity_automated_invoicing']
                }).custentity_automated_invoicing;

                if (!shipped || !customerAdvance)
                    return log.audit('Script Stopped', { reason: 'Billing conditions not met', ifNumber, shipped, customerAdvance });
            }

            log.audit('IF Validation', { ifNumber, soId, advance, shipped, event: context.type });

            /* ---------- Existing invoice for this IF -> reversal path ---------- */
            const existing = search.create({
                type: search.Type.INVOICE,
                filters: [
                    ['createdfrom', 'anyof', soId], 'AND',
                    ['mainline', 'is', 'T'], 'AND',
                    ['custbody_sourced_if', 'is', ifNumber]
                ],
                columns: ['internalid']
            }).run().getRange({ start: 0, end: 1 });

            if (existing.length) {
                const invoiceId = existing[0].id;
                const jeId = ff.getValue('custbody_related_je');

                if (!(shipped && jeId))
                    return log.audit('Invoice Already Exists', { ifNumber, invoiceId, shipped });

                /* ---------- Standard NetSuite reversal: set Reversal Date on the COGS JE ---------- */
                const { reversaldate } = search.lookupFields({
                    type: search.Type.JOURNAL_ENTRY,
                    id: jeId,
                    columns: ['reversaldate']
                });
                if (reversaldate) return log.audit('Reversal Already Set', { ifNumber, invoiceId, jeId, reversaldate });

                record.submitFields({
                    type: record.Type.JOURNAL_ENTRY,
                    id: jeId,
                    values: { reversaldate: new Date() }
                });
                return log.audit('COGS JE Reversal Date Set', { ifNumber, invoiceId, jeId });
            }

            /* ---------- Fulfilled quantities by SO line ---------- */
            const lines = {};
            for (let i = 0; i < ff.getLineCount({ sublistId: 'item' }); i++) {
                const line = ff.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i });
                const qty = +ff.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }) || 0;
                if (line && qty > 0) lines[line] = (lines[line] || 0) + qty;
            }
            if (!Object.keys(lines).length) return log.audit('Script Stopped', 'No fulfillment quantities found');

            /* ---------- NEW: read Ship To + lots from the IF ---------- */
            const ifShipAddress = getIfShipAddress(ff);
            const ifLots = getIfLots(ff);
            if (Object.keys(ifLots).length) log.audit('IF Lots', ifLots);

            /* ---------- Check JE parameters BEFORE saving anything (advance billing) ---------- */
            let debitAccount, creditAccount;
            if (!shipped) {
                const script = runtime.getCurrentScript();
                debitAccount = +script.getParameter({ name: 'custscript_je_debit_account' });
                creditAccount = +script.getParameter({ name: 'custscript_je_credit_account' });
                if (!debitAccount || !creditAccount) throw Error('JE account parameters missing');
            }

            /* ---------- Flat Rate lines from the Sales Order (Rate = 0, Amount > 0) ---------- */
            const so = record.load({ type: record.Type.SALES_ORDER, id: soId });
            const flatLines = {};
            for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {
                const get = (fieldId) => so.getSublistValue({ sublistId: 'item', fieldId, line: i });
                const lineId = String(get('line'));
                if (!lines[lineId]) continue;

                const rate = +get('rate') || 0;
                const amount = +get('amount') || 0;
                // if (rate === 0 && amount > 0) {
                //     const soQty = +get('quantity') || 0;
                //     const billedQty = +get('quantitybilled') || 0;
                //     flatLines[lineId] = {
                //         amount,
                //         qty: soQty - billedQty,
                //         alreadyBilled: billedQty >= soQty
                //     };
                // }
                if (rate === 0 && amount > 0) {
                    const billedQty = +get('quantitybilled') || 0;
                    flatLines[lineId] = {
                        amount,
                        alreadyBilled: billedQty > 0   // flat amount already invoiced -> next invoices are $0
                    };
                }              
            }
            if (Object.keys(flatLines).length) log.audit('Flat Rate Lines', flatLines);

            const expected = Object.keys(lines).length;
            if (!expected) {
                return log.audit('Script Stopped', { reason: 'Nothing to invoice', ifNumber, soId });
            }          
            // const expected = Object.keys(lines).filter((l) => !(flatLines[l] && flatLines[l].alreadyBilled)).length;
            // if (!expected) {
            //     return log.audit('Script Stopped', { reason: 'Nothing to invoice - flat rate line(s) already fully billed', ifNumber, soId });
            // }

            /* ---------- Build invoice ---------- */
            const invoice = record.transform({
                fromType: record.Type.SALES_ORDER,
                fromId: soId,
                toType: record.Type.INVOICE
            });

            invoice.setValue({ fieldId: 'custbody_sourced_if', value: ifNumber });
            invoice.setValue({
                fieldId: 'memo',
                value: (shipped ? 'Normal Shipping' : 'Advance Billing') + ' - IF ' + ifNumber + ' (ID ' + ff.id + ')'
            });

            /* ---------- NEW: Ship To from the IF ---------- */
            setInvoiceShipAddress(invoice, ifShipAddress);

            let matched = 0;
            const costLines = [];
            const flatToVerify = {};

            for (let i = invoice.getLineCount({ sublistId: 'item' }) - 1; i >= 0; i--) {
                const line = String(invoice.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i }));
                const fulfilledQty = lines[line];
                const flat = flatLines[line];

                if (!fulfilledQty) {
                    invoice.removeLine({ sublistId: 'item', line: i });
                    continue;
                }

                if (flat) {
                    const flatAmount = flat.alreadyBilled ? 0 : flat.amount;
                    invoice.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: fulfilledQty });
                    invoice.setSublistValue({ sublistId: 'item', fieldId: 'amount', line: i, value: flatAmount });
                    flatToVerify[line] = flatAmount;
                    log.audit(flat.alreadyBilled ? 'Flat Rate Billed at $0 (amount already invoiced)' : 'Flat Rate Billed (fulfilled qty + full amount)',
                        { line, fulfilledQty, amount: flatAmount });
                } else {              
                // if (!fulfilledQty || (flat && flat.alreadyBilled)) {
                //     if (flat && flat.alreadyBilled) log.audit('Flat Rate Skipped (already fully billed)', { line });
                //     invoice.removeLine({ sublistId: 'item', line: i });
                //     continue;
                // }

                // if (flat) {
                //     invoice.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: flat.qty });
                //     invoice.setSublistValue({ sublistId: 'item', fieldId: 'amount', line: i, value: flat.amount });
                //     flatToVerify[line] = flat.amount;
                //     log.audit('Flat Rate Billed (full qty + amount)', { line, fulfilledQty, billedQty: flat.qty, amount: flat.amount });
                // } else {
                    invoice.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: fulfilledQty });
                }

                /* ---------- NEW: lots + expiry from the IF ---------- */
                if (ifLots[line]) {
                    invoice.setSublistValue({ sublistId: 'item', fieldId: 'custcol_nscs_lot_number_porec', line: i,
                        value: ifLots[line].map((l) => l.number).join(', ').substring(0, 300) });
                    invoice.setSublistValue({ sublistId: 'item', fieldId: 'custcol_so_expiration_date', line: i,
                        value: ifLots[line].map((l) => l.expiry).join(', ').substring(0, 300) });
                }

                matched++;
                if (!shipped) {
                    costLines.push({
                        itemId: invoice.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }),
                        qty: fulfilledQty
                    });
                }
            }

            log.audit('Invoice Ready', { ifNumber, matched, expected, fulfillmentLines: Object.keys(lines).length });

            //if (!matched) return log.audit('Script Stopped', 'Nothing to invoice (flat rate already billed or no lines matched)');
            if (!matched) return log.audit('Script Stopped', 'Nothing to invoice (no lines matched)');          
            if (matched !== expected) throw Error('Some IF lines are missing from invoice transform');

            /* ---------- Advance billing COGS ---------- */
            let totalCost = 0;
            if (!shipped) {
                const costs = {};
                search.create({
                    type: search.Type.ITEM,
                    filters: [['internalid', 'anyof', [...new Set(costLines.map((c) => c.itemId))]]],
                    columns: ['averagecost', 'lastpurchaseprice']
                }).run().each((r) => {
                    costs[r.id] = (+r.getValue('averagecost')) || (+r.getValue('lastpurchaseprice')) || 1;
                    return true;
                });

                for (const c of costLines) totalCost += c.qty * (costs[c.itemId] || 1);
                if (totalCost <= 0) throw Error('Invalid COGS amount');
            }

            const invoiceId = invoice.save();

            /* ---------- Verify NetSuite kept the flat amount on the SAVED invoice ---------- */
            if (Object.keys(flatToVerify).length) {
                const saved = record.load({ type: record.Type.INVOICE, id: invoiceId });
                const fixes = [];
                for (let i = 0; i < saved.getLineCount({ sublistId: 'item' }); i++) {
                    const line = String(saved.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i }));
                    if (!(line in flatToVerify)) continue;
                    const actual = +saved.getSublistValue({ sublistId: 'item', fieldId: 'amount', line: i }) || 0;
                    if (Math.abs(actual - flatToVerify[line]) >= 0.01) {
                        saved.setSublistValue({ sublistId: 'item', fieldId: 'amount', line: i, value: flatToVerify[line] });
                        fixes.push({ line, expected: flatToVerify[line], actual });
                    }
                }
                if (fixes.length) {
                    try {
                        saved.save();
                        log.audit('Flat Rate Amount Corrected', { invoiceId, fixes });
                    } catch (err) {
                        log.error('Flat Rate Amount Mismatch - correction failed', { invoiceId, fixes, message: err.message });
                        throw err;
                    }
                }
            }

            /* ---------- NEW: start invoice email workflow (never breaks invoicing) ---------- */
            try {
                workflow.initiate({
                    recordType: record.Type.INVOICE,
                    recordId: invoiceId,
                    workflowId: INVOICE_EMAIL_WORKFLOW
                });
                log.audit('Invoice Email Workflow Started', { ifNumber, invoiceId });
            } catch (err) {
                log.error('Invoice Email Workflow Failed', { ifNumber, invoiceId, message: err.message });
            }

            if (shipped) return log.audit('Normal Invoice Created', { ifNumber, invoiceId });

            /* ---------- Advance billing COGS JE ---------- */
            const invTranId = search.lookupFields({ type: search.Type.INVOICE, id: invoiceId, columns: ['tranid'] }).tranid;
            const memo = 'Advance Billing COGS - Invoice ' + invTranId;
            const je = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });
            const subsidiary = invoice.getValue('subsidiary');
            if (subsidiary) je.setValue({ fieldId: 'subsidiary', value: subsidiary });
            je.setValue({ fieldId: 'memo', value: memo });
            je.setValue({ fieldId: 'custbody_related_record', value: ff.id }); 

            for (const entry of [
                { account: debitAccount, field: 'debit' },
                { account: creditAccount, field: 'credit' }
            ]) {
                je.selectNewLine({ sublistId: 'line' });
                je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: entry.account });
                je.setCurrentSublistValue({ sublistId: 'line', fieldId: entry.field, value: totalCost });
                je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: memo });
                je.commitLine({ sublistId: 'line' });
            }

            const jeId = je.save();

            record.submitFields({
                type: record.Type.ITEM_FULFILLMENT,
                id: ff.id,
                values: { custbody_related_je: jeId }
            });

            log.audit('Advance Billing Completed', { ifNumber, invoiceId, jeId, totalCost });

        } catch (e) {
            log.error('IF Invoicing Error', { name: e.name, message: e.message, stack: e.stack });
            throw e;
        }
    };

    return { afterSubmit };
});