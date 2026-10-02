/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log'], (record, log) => {

    const afterSubmit = (context) => {
        try {
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) return;

            const so = context.newRecord;

            if (!so.getValue('custbody_advance_billing')) return;

            let toBill = false;

            for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {
                const qty = Number(so.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 0;
                const billed = Number(so.getSublistValue({ sublistId: 'item', fieldId: 'quantitybilled', line: i })) || 0;

                if (qty > billed) {
                    toBill = true;
                    break;
                }
            }

            if (!toBill) return;

            log.debug('Advance Billing', { salesOrderId: so.id });

            const invoiceId = record.transform({
                fromType: record.Type.SALES_ORDER,
                fromId: so.id,
                toType: record.Type.INVOICE,
                isDynamic: true
            }).save();

            log.debug('Invoice Created', { invoiceId: invoiceId });

        } catch (e) {
            log.error('Advance Billing Error', e);
            throw e;
        }
    };

    return { afterSubmit };
});
