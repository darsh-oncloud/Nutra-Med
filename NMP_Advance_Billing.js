/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log', 'N/search'], (record, log, search) => {

    const COGS_ACCOUNT = 488;      // 50000 Standard Direct Materials
    const ACCRUAL_ACCOUNT = 453;   // 23300 Accrued Expenses

    const afterSubmit = (context) => {
        try {

            log.debug('Script Triggered', {
                eventType: context.type,
                salesOrderId: context.newRecord.id
            });

            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) return;

            const so = context.newRecord;
            const advanceBilling = so.getValue('custbody_advance_billing');

            log.debug('Advance Billing Checkbox', {
                value: advanceBilling
            });

            if (!advanceBilling) {
                log.debug('Script Stopped', 'Advance Billing checkbox is false');
                return;
            }

            let toBill = false;

            for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {

                const qty = Number(so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: i
                })) || 0;

                const billed = Number(so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantitybilled',
                    line: i
                })) || 0;

                log.debug('Line Check ' + i, {
                    quantity: qty,
                    quantityBilled: billed,
                    remaining: qty - billed
                });

                if (qty > billed) {
                    toBill = true;
                    break;
                }
            }

            log.debug('Available To Invoice', {
                toBill: toBill
            });

            if (!toBill) {
                log.debug('Script Stopped', 'Nothing remaining to invoice');
                return;
            }

            const invoice = record.transform({
                fromType: record.Type.SALES_ORDER,
                fromId: so.id,
                toType: record.Type.INVOICE,
                isDynamic: true
            });

            let totalCost = 0;

            for (let i = 0; i < invoice.getLineCount({ sublistId: 'item' }); i++) {

                const itemId = invoice.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                const qty = Number(invoice.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: i
                })) || 0;

                if (!itemId || !qty) continue;

                const item = search.lookupFields({
                    type: search.Type.ITEM,
                    id: itemId,
                    columns: ['averagecost', 'lastpurchaseprice']
                });

                const avgCost = Number(item.averagecost) || 0;
                const lastPrice = Number(item.lastpurchaseprice) || 0;

                // Average Cost -> Last Purchase Price -> $1
                const cost = avgCost || lastPrice || 1;
                const lineCost = qty * cost;

                totalCost += lineCost;

                log.debug('Cost Line ' + i, {
                    itemId: itemId,
                    quantity: qty,
                    averageCost: avgCost,
                    lastPurchasePrice: lastPrice,
                    costUsed: cost,
                    lineCost: lineCost
                });
            }

            const invoiceId = invoice.save();

            log.debug('Invoice Created', {
                invoiceId: invoiceId,
                salesOrderId: so.id
            });

            if (!totalCost) {
                log.debug('JE Stopped', 'Total calculated cost is 0');
                return;
            }

            const je = record.create({
                type: record.Type.JOURNAL_ENTRY,
                isDynamic: true
            });

            const subsidiary = invoice.getValue('subsidiary');

            if (subsidiary) {
                je.setValue({
                    fieldId: 'subsidiary',
                    value: subsidiary
                });
            }

            je.setValue({
                fieldId: 'memo',
                value: 'Advance Billing COGS - Invoice ' + invoiceId
            });

            // Debit COGS
            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({
                sublistId: 'line',
                fieldId: 'account',
                value: COGS_ACCOUNT
            });
            je.setCurrentSublistValue({
                sublistId: 'line',
                fieldId: 'debit',
                value: totalCost
            });
            je.setCurrentSublistValue({
                sublistId: 'line',
                fieldId: 'memo',
                value: 'Advance Billing COGS - Invoice ' + invoiceId
            });
            je.commitLine({ sublistId: 'line' });

            // Credit Accrued Expenses
            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({
                sublistId: 'line',
                fieldId: 'account',
                value: ACCRUAL_ACCOUNT
            });
            je.setCurrentSublistValue({
                sublistId: 'line',
                fieldId: 'credit',
                value: totalCost
            });
            je.setCurrentSublistValue({
                sublistId: 'line',
                fieldId: 'memo',
                value: 'Advance Billing COGS - Invoice ' + invoiceId
            });
            je.commitLine({ sublistId: 'line' });

            const jeId = je.save();

            log.debug('Advance Billing Completed', {
                salesOrderId: so.id,
                invoiceId: invoiceId,
                journalEntryId: jeId,
                journalAmount: totalCost
            });

        } catch (e) {

            log.error('Advance Billing Error', {
                message: e.message,
                name: e.name,
                stack: e.stack
            });

            throw e;
        }
    };

    return { afterSubmit };
});