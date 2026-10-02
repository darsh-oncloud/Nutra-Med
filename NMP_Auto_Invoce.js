/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log'], (record, log) => {

    const afterSubmit = (context) => {
        const { type, UserEventType } = context;

        if (type !== UserEventType.CREATE &&
            type !== UserEventType.EDIT &&
            type !== UserEventType.SHIP) return;

        // SHIP may not include full sublist data
        const ff = type === UserEventType.SHIP
            ? record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: context.newRecord.id
            })
            : context.newRecord;

        // Only when status is Shipped
        if (ff.getValue('shipstatus') !== 'C') return;

        // Do not create invoice again if already shipped
        if (context.oldRecord &&
            context.oldRecord.getValue('shipstatus') === 'C') return;

        const soId = ff.getValue('createdfrom');
        if (!soId) return;

        log.debug('Fulfillment Processing', {
            fulfillmentId: ff.id,
            salesOrderId: soId,
            eventType: type
        });

        // SO line -> fulfilled quantity
        const lines = {};

        for (let i = 0; i < ff.getLineCount({ sublistId: 'item' }); i++) {

            const orderLine = ff.getSublistValue({
                sublistId: 'item',
                fieldId: 'orderline',
                line: i
            });

            const qty = Number(ff.getSublistValue({
                sublistId: 'item',
                fieldId: 'quantity',
                line: i
            })) || 0;

            if (orderLine && qty)
                lines[orderLine] = (lines[orderLine] || 0) + qty;
        }

        if (!Object.keys(lines).length) return;

        log.debug('Fulfilled Lines', lines);

        const invoice = record.transform({
            fromType: record.Type.SALES_ORDER,
            fromId: soId,
            toType: record.Type.INVOICE
        });

        // Keep only lines from this fulfillment
        for (let i = invoice.getLineCount({ sublistId: 'item' }) - 1; i >= 0; i--) {

            const orderLine = invoice.getSublistValue({
                sublistId: 'item',
                fieldId: 'orderline',
                line: i
            });

            if (!lines[orderLine]) {

                invoice.removeLine({
                    sublistId: 'item',
                    line: i
                });

            } else {

                invoice.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: i,
                    value: lines[orderLine]
                });
            }
        }

        if (invoice.getLineCount({ sublistId: 'item' }) > 0) {

            const invoiceId = invoice.save();

            log.debug('Invoice Created', {
                invoiceId: invoiceId,
                fulfillmentId: ff.id,
                salesOrderId: soId
            });
        }
    };

    return { afterSubmit };
});