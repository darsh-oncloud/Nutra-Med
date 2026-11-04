/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Item Fulfillment -> Auto Invoice (+ Advance Billing COGS JE / reversal)
 * Flat Rate rule: SO line with Rate = 0 and Amount > 0 is billed for its FULL
 * SO quantity and FULL amount on the first invoice (whatever qty was fulfilled).
 * The SO line is then fully billed, so later transforms simply won't bring it in.
 */
define(['N/record', 'N/search', 'N/runtime', 'N/log'], (record, search, runtime, log) => {

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
                    columns: ['custentity_auto_invoicing']
                }).custentity_auto_invoicing;

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

                const memo = 'Advance Billing Reversal - Invoice ' + invoiceId;
                const reversed = search.create({
                    type: search.Type.JOURNAL_ENTRY,
                    filters: [['mainline', 'is', 'T'], 'AND', ['memo', 'is', memo]],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });

                if (reversed.length) return log.audit('Reversal Already Exists', { ifNumber, invoiceId });

                const original = record.load({ type: record.Type.JOURNAL_ENTRY, id: jeId });
                const rev = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });

                for (const f of ['subsidiary', 'currency', 'exchangerate']) {
                    const v = original.getValue(f);
                    if (v) rev.setValue({ fieldId: f, value: v });
                }
                rev.setValue({ fieldId: 'memo', value: memo });

                for (let i = 0; i < original.getLineCount({ sublistId: 'line' }); i++) {
                    const get = (fieldId) => original.getSublistValue({ sublistId: 'line', fieldId, line: i });
                    const debit = +get('debit') || 0;
                    const credit = +get('credit') || 0;

                    rev.selectNewLine({ sublistId: 'line' });
                    rev.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: get('account') });
                    if (debit) rev.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: debit });
                    if (credit) rev.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: credit });
                    rev.commitLine({ sublistId: 'line' });
                }

                const reversalId = rev.save();
                return log.audit('COGS JE Reversed', { ifNumber, invoiceId, jeId, reversalId });
            }

            /* ---------- Fulfilled quantities by SO line ---------- */
            const lines = {};
            for (let i = 0; i < ff.getLineCount({ sublistId: 'item' }); i++) {
                const line = ff.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i });
                const qty = +ff.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }) || 0;
                if (line && qty > 0) lines[line] = (lines[line] || 0) + qty;
            }
            if (!Object.keys(lines).length) return log.audit('Script Stopped', 'No fulfillment quantities found');

            /* ---------- Check JE parameters BEFORE saving anything (advance billing) ---------- */
            let debitAccount, creditAccount;
            if (!shipped) {
                const script = runtime.getCurrentScript();
                debitAccount = +script.getParameter({ name: 'custscript_je_debit_account' });
                creditAccount = +script.getParameter({ name: 'custscript_je_credit_account' });
                if (!debitAccount || !creditAccount) throw Error('JE account parameters missing');
            }

            /* ---------- Flat Rate lines from the Sales Order (Rate = 0, Amount > 0) ---------- */
            // Flat line bills its full remaining SO qty + full amount on the first invoice.
            // If the SO line is already fully billed, it won't come through the transform.
            const so = record.load({ type: record.Type.SALES_ORDER, id: soId });
            const flatLines = {};
            for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {
                const get = (fieldId) => so.getSublistValue({ sublistId: 'item', fieldId, line: i });
                const lineId = String(get('line'));
                if (!lines[lineId]) continue;                       // only lines on this IF

                const rate = +get('rate') || 0;
                const amount = +get('amount') || 0;
                if (rate === 0 && amount > 0) {
                    const soQty = +get('quantity') || 0;
                    const billedQty = +get('quantitybilled') || 0;
                    flatLines[lineId] = {
                        amount,
                        qty: soQty - billedQty,                     // first invoice = full SO qty
                        alreadyBilled: billedQty >= soQty
                    };
                }
            }
            if (Object.keys(flatLines).length) log.audit('Flat Rate Lines', flatLines);

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

            let matched = 0;
            const costLines = [];
            const flatToVerify = {};   // orderline -> expected amount

            for (let i = invoice.getLineCount({ sublistId: 'item' }) - 1; i >= 0; i--) {
                const line = String(invoice.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i }));
                const fulfilledQty = lines[line];
                const flat = flatLines[line];

                // Not on this IF, or flat-rate line already fully billed -> drop it
                if (!fulfilledQty || (flat && flat.alreadyBilled)) {
                    if (flat && flat.alreadyBilled) log.audit('Flat Rate Skipped (already fully billed)', { line });
                    invoice.removeLine({ sublistId: 'item', line: i });
                    continue;
                }

                if (flat) {
                    // Flat rate: full SO qty, then full SO amount (set AFTER quantity)
                    invoice.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: flat.qty });
                    invoice.setSublistValue({ sublistId: 'item', fieldId: 'amount', line: i, value: flat.amount });
                    flatToVerify[line] = flat.amount;
                    log.audit('Flat Rate Billed (full qty + amount)', { line, fulfilledQty, billedQty: flat.qty, amount: flat.amount });
                } else {
                    invoice.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: fulfilledQty });
                }

                matched++;
                if (!shipped) {
                    costLines.push({
                        itemId: invoice.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }),
                        qty: fulfilledQty
                    });
                }
            }

            // Lines expected on the invoice = IF lines minus flat lines already fully billed on the SO
            const expected = Object.keys(lines).filter((l) => !(flatLines[l] && flatLines[l].alreadyBilled)).length;

            log.audit('Invoice Ready', { ifNumber, matched, expected, fulfillmentLines: Object.keys(lines).length });

            if (!matched) return log.audit('Script Stopped', 'Nothing to invoice (flat rate already billed or no lines matched)');
            if (matched !== expected) throw Error('Some IF lines are missing from invoice transform');

            /* ---------- Advance billing COGS (one item search instead of per-line lookups) ---------- */
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

            if (shipped) return log.audit('Normal Invoice Created', { ifNumber, invoiceId });

            /* ---------- Advance billing COGS JE ---------- */
            const memo = 'Advance Billing COGS - Invoice ' + invoiceId;
            const je = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });
            const subsidiary = invoice.getValue('subsidiary');
            if (subsidiary) je.setValue({ fieldId: 'subsidiary', value: subsidiary });
            je.setValue({ fieldId: 'memo', value: memo });

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