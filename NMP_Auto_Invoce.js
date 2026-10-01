/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record'], (record) => {

    const afterSubmit = (context) => {

        const fulfillment = context.newRecord;

        // Run only when fulfillment is Shipped
        if (fulfillment.getValue('shipstatus') !== 'C') return;

        // On Edit, run only when status changes TO Shipped
        if (context.type === context.UserEventType.EDIT &&
            context.oldRecord.getValue('shipstatus') === 'C') return;

        if (context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT) return;

        const soId = fulfillment.getValue('createdfrom');
        if (!soId) return;

        // Get fulfilled items and quantities
        const items = {};

        for (let i = 0; i < fulfillment.getLineCount({ sublistId: 'item' }); i++) {

            const item = fulfillment.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            const qty = Number(fulfillment.getSublistValue({
                sublistId: 'item',
                fieldId: 'quantity',
                line: i
            })) || 0;

            if (qty) items[item] = (items[item] || 0) + qty;
        }

        // Transform SO to Invoice
        const invoice = record.transform({
            fromType: record.Type.SALES_ORDER,
            fromId: soId,
            toType: record.Type.INVOICE
        });

        // Keep only items from this fulfillment
        for (let i = invoice.getLineCount({ sublistId: 'item' }) - 1; i >= 0; i--) {

            const item = invoice.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            if (!items[item]) {
                invoice.removeLine({
                    sublistId: 'item',
                    line: i
                });
            } else {
                invoice.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: i,
                    value: items[item]
                });
            }
        }

        invoice.save();
    };

    return { afterSubmit };
});