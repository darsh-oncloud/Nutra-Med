/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Item Fulfillment -> Auto Invoice (+ Advance Billing COGS JE / reversal)
 * Flat Rate rule: SO line with Rate = 0 and Amount > 0 is billed for its FULL
 * SO quantity and FULL amount on the first invoice (whatever qty was fulfilled).
 * The SO line is then fully billed, so later transforms simply won't bring it in.
 *
 * + Automated invoice email: after the invoice is created, emails it to the customer
 *   if the Customer "Send Invoice Email" checkbox is checked and total > 0.
 */
define(['N/record', 'N/search', 'N/runtime', 'N/log', 'N/render', 'N/email'],
    (record, search, runtime, log, render, email) => {

    /* ===================== INVOICE EMAIL SETTINGS ===================== */
    const EMAIL_TEMPLATE_ID = 8;                 // Email Template internal ID
    const EMAIL_SENDER_ID = 8664;                // AR employee (From)
    const EMAIL_TEST_RECIPIENT = '';             // put your email here to test; '' = LIVE (customer)
    const CUST_SEND_EMAIL = 'custentity_send_invoice_email';
    const CUST_CC_FIELD = 'custentity_additional_external_inv_email';
    const INV_EMAIL_SENT = 'custbody_email_sent';
    /* ================================================================== */

    /**
     * Emails the invoice if the customer is enrolled. NEVER throws, so it can
     * never break invoice / JE creation.
     */
    const sendInvoiceEmail = (invoiceId) => {
        try {
            const splitEmails = (str) => {
                const seen = {};
                return String(str || '').split(/[;,\s]+/).map(s => s.trim())
                    .filter(s => s && s.indexOf('@') > 0)
                    .filter(s => (seen[s.toLowerCase()] ? false : (seen[s.toLowerCase()] = true)));
            };
            const isTrue = (v) => v === true || v === 'T';

            const inv = search.lookupFields({
                type: search.Type.INVOICE, id: invoiceId,
                columns: ['tranid', 'entity', 'email', 'total', INV_EMAIL_SENT]
            });
            const tranId = inv.tranid || String(invoiceId);
            const customerId = Number(inv.entity && inv.entity[0] ? inv.entity[0].value : 0);
            const total = parseFloat(inv.total) || 0;

            const cust = search.lookupFields({
                type: search.Type.CUSTOMER, id: customerId,
                columns: ['email', CUST_SEND_EMAIL, CUST_CC_FIELD]
            });

            if (!isTrue(cust[CUST_SEND_EMAIL])) return log.audit('Invoice Email Skipped', { tranId, reason: 'customer checkbox not checked' });
            if (total <= 0) return log.audit('Invoice Email Skipped', { tranId, reason: '$0 invoice', total });
            if (isTrue(inv[INV_EMAIL_SENT])) return log.audit('Invoice Email Skipped', { tranId, reason: 'already sent' });

            let to = splitEmails(cust.email);
            if (!to.length) to = splitEmails(inv.email);
            if (!to.length) return log.error('Invoice Email Skipped', { tranId, reason: 'customer has no email address' });
            to = to.slice(0, 10);
            const toLower = to.map(e => e.toLowerCase());
            const cc = splitEmails(cust[CUST_CC_FIELD]).filter(e => toLower.indexOf(e.toLowerCase()) < 0).slice(0, 10);

            const merged = render.mergeEmail({
                templateId: EMAIL_TEMPLATE_ID,
                entity: { type: 'customer', id: customerId },
                transactionId: Number(invoiceId)
            });
            const pdf = render.transaction({ entityId: Number(invoiceId), printMode: render.PrintMode.PDF });
            pdf.name = 'Invoice_' + tranId + '.pdf';

            const opts = {
                author: EMAIL_SENDER_ID,
                recipients: to,
                subject: merged.subject,
                body: merged.body,
                attachments: [pdf],
                relatedRecords: { transactionId: Number(invoiceId), entityId: customerId }
            };
            if (cc.length) opts.cc = cc;

            if (EMAIL_TEST_RECIPIENT) {
                opts.recipients = [EMAIL_TEST_RECIPIENT];
                delete opts.cc;
                opts.subject = '[TEST] ' + opts.subject;
                opts.body = '<p style="background:#fff3cd;padding:8px">TEST - Live TO: ' + to.join(', ') +
                    ' | Live CC: ' + (cc.join(', ') || '(none)') + '</p>' + opts.body;
            }

            email.send(opts);

            record.submitFields({
                type: record.Type.INVOICE, id: invoiceId,
                values: { [INV_EMAIL_SENT]: true },
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            log.audit('Invoice Email Sent', { tranId, to: opts.recipients, cc: opts.cc || [] });
        } catch (err) {
            log.error('Invoice Email Failed', { invoiceId, name: err.name, message: err.message });
        }
    };

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
                if (rate === 0 && amount > 0) {
                    const soQty = +get('quantity') || 0;
                    const billedQty = +get('quantitybilled') || 0;
                    flatLines[lineId] = {
                        amount,
                        qty: soQty - billedQty,
                        alreadyBilled: billedQty >= soQty
                    };
                }
            }
            if (Object.keys(flatLines).length) log.audit('Flat Rate Lines', flatLines);

            const expected = Object.keys(lines).filter((l) => !(flatLines[l] && flatLines[l].alreadyBilled)).length;
            if (!expected) {
                return log.audit('Script Stopped', { reason: 'Nothing to invoice - flat rate line(s) already fully billed', ifNumber, soId });
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

            /* ---------- NEW: Ship To from the IF ---------- */
            setInvoiceShipAddress(invoice, ifShipAddress);

            let matched = 0;
            const costLines = [];
            const flatToVerify = {};

            for (let i = invoice.getLineCount({ sublistId: 'item' }) - 1; i >= 0; i--) {
                const line = String(invoice.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i }));
                const fulfilledQty = lines[line];
                const flat = flatLines[line];

                if (!fulfilledQty || (flat && flat.alreadyBilled)) {
                    if (flat && flat.alreadyBilled) log.audit('Flat Rate Skipped (already fully billed)', { line });
                    invoice.removeLine({ sublistId: 'item', line: i });
                    continue;
                }

                if (flat) {
                    invoice.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: flat.qty });
                    invoice.setSublistValue({ sublistId: 'item', fieldId: 'amount', line: i, value: flat.amount });
                    flatToVerify[line] = flat.amount;
                    log.audit('Flat Rate Billed (full qty + amount)', { line, fulfilledQty, billedQty: flat.qty, amount: flat.amount });
                } else {
                    invoice.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: fulfilledQty });
                }

                /* ---------- NEW: lots + expiry from the IF ---------- */
                if (ifLots[line]) setInvoiceLineLots(invoice, i, ifLots[line], flat ? flat.qty : fulfilledQty, line);

                matched++;
                if (!shipped) {
                    costLines.push({
                        itemId: invoice.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }),
                        qty: fulfilledQty
                    });
                }
            }

            log.audit('Invoice Ready', { ifNumber, matched, expected, fulfillmentLines: Object.keys(lines).length });

            if (!matched) return log.audit('Script Stopped', 'Nothing to invoice (flat rate already billed or no lines matched)');
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

            /* ---------- NEW: automated invoice email (final amounts are saved now) ---------- */
            sendInvoiceEmail(invoiceId);

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