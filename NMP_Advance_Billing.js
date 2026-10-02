/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log'], (record, log) => {

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

            log.debug('Creating Invoice', {
                salesOrderId: so.id
            });

            const invoiceId = record.transform({
                fromType: record.Type.SALES_ORDER,
                fromId: so.id,
                toType: record.Type.INVOICE,
                isDynamic: true
            }).save();

            log.debug('Invoice Created', {
                invoiceId: invoiceId,
                salesOrderId: so.id
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