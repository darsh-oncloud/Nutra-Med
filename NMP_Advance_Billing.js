/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Item Fulfillment -> Auto Invoice (+ Advance Billing COGS JE / reversal)
 * Flat Rate rule: SO line with Rate = 0 and Amount > 0 is billed its full amount
 * on the first invoice only; later fulfillments skip that line.
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
                    columns: ['custentity_advance_billing']
                }).custentity_advance_billing;

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
            const so = record.load({ type: record.Type.SALES_ORDER, id: soId });
            const flatLines = {};
            for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {
                const get = (fieldId) => so.getSublistValue({ sublistId: 'item', fieldId, line: i });
                const lineId = String(get('line'));
                if (!lines[lineId]) continue;                       // only lines on this IF

                const rate = +get('rate') || 0;
                const amount = +get('amount') || 0;
                if (rate === 0 && amount > 0) {
                    flatLines[lineId] = { itemId: String(get('item')), amount, alreadyBilled: false };
                }
            }

            /* ---------- Was the full flat amount already billed on an existing invoice? ---------- */
            const flatIds = Object.keys(flatLines);
            if (flatIds.length) {
                // Only invoices on this SO that contain a flat-rate item
                const invoiceIds = [];
                search.create({
                    type: search.Type.INVOICE,
                    filters: [
                        ['createdfrom', 'anyof', soId], 'AND',
                        ['mainline', 'is', 'F'], 'AND',
                        ['voided', 'is', 'F'], 'AND',
                        ['item', 'anyof', [...new Set(flatIds.map((l) => flatLines[l].itemId))]]
                    ],
                    columns: [search.createColumn({ name: 'internalid', summary: search.Summary.GROUP })]
                }).run().each((r) => {
                    invoiceIds.push(r.getValue({ name: 'internalid', summary: search.Summary.GROUP }));
                    return true;
                });

                // Exact match: same SO line (orderline) + same full amount = already billed
                for (const id of invoiceIds) {
                    if (flatIds.every((l) => flatLines[l].alreadyBilled)) break;
                    const prev = record.load({ type: record.Type.INVOICE, id });
                    for (let i = 0; i < prev.getLineCount({ sublistId: 'item' }); i++) {
                        const ol = String(prev.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i }));
                        const f = flatLines[ol];
                        if (!f || f.alreadyBilled) continue;
                        const amt = +prev.getSublistValue({ sublistId: 'item', fieldId: 'amount', line: i }) || 0;
                        if (Math.abs(amt - f.amount) < 0.01) {
                            f.alreadyBilled = true;
                            f.billedOn = id;
                        }
                    }
                }
                log.audit('Flat Rate Lines', flatLines);
            }

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
                const qty = lines[line];
                const flat = flatLines[line];

                // Not on this IF, or flat-rate line already billed -> drop it
                if (!qty || (flat && flat.alreadyBilled)) {
                    if (flat && flat.alreadyBilled) log.audit('Flat Rate Skipped (already billed)', { line });
                    invoice.removeLine({ sublistId: 'item', line: i });
                    continue;
                }

                invoice.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: qty });

                // First bill of a flat-rate line -> full SO line amount (set AFTER quantity)
                if (flat) {
                    invoice.setSublistValue({ sublistId: 'item', fieldId: 'amount', line: i, value: flat.amount });
                    flatToVerify[line] = flat.amount;
                    log.audit('Flat Rate Billed', { line, qty, amount: flat.amount });
                }

                matched++;
                if (!shipped) {
                    costLines.push({
                        itemId: invoice.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }),
                        qty
                    });
                }
            }

            // Lines expected on the invoice = IF lines minus flat lines already billed
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
