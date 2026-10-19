/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record','N/search','N/runtime','N/log'], (record, search, runtime, log) => {

    const afterSubmit = (context) => {
        try {
            if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) return;

            const so = context.newRecord;
            if (!so.getValue('custbody_advance_billing')) return;

            let toBill = false;
            for (let i = 0; i < so.getLineCount({sublistId:'item'}); i++) {
                const qty = +so.getSublistValue({sublistId:'item',fieldId:'quantity',line:i}) || 0;
                const billed = +so.getSublistValue({sublistId:'item',fieldId:'quantitybilled',line:i}) || 0;
                if (qty > billed) { toBill = true; break; }
            }

            if (!toBill) {
                log.debug('Script Stopped','Nothing remaining to invoice');
                return;
            }

            const script = runtime.getCurrentScript();
            const debitAccount = +script.getParameter({name:'custscript_je_debit_account'});
            const creditAccount = +script.getParameter({name:'custscript_je_credit_account'});

            if (!debitAccount || !creditAccount) throw Error('JE Debit/Credit account parameter is missing');

            const invoice = record.transform({
                fromType:record.Type.SALES_ORDER,
                fromId:so.id,
                toType:record.Type.INVOICE,
                isDynamic:true
            });

            let totalCost = 0;

            for (let i = 0; i < invoice.getLineCount({sublistId:'item'}); i++) {
                const itemId = invoice.getSublistValue({sublistId:'item',fieldId:'item',line:i});
                const qty = +invoice.getSublistValue({sublistId:'item',fieldId:'quantity',line:i}) || 0;
                if (!itemId || !qty) continue;

                const item = search.lookupFields({
                    type:search.Type.ITEM,
                    id:itemId,
                    columns:['averagecost','lastpurchaseprice']
                });

                const avgCost = +item.averagecost || 0;
                const lastPrice = +item.lastpurchaseprice || 0;
                const cost = avgCost || lastPrice || 1;
                const lineCost = qty * cost;
                totalCost += lineCost;

                log.debug('Cost Line '+i,{
                    itemId, quantity:qty, averageCost:avgCost,
                    lastPurchasePrice:lastPrice, costUsed:cost, lineCost
                });
            }

            const invoiceId = invoice.save();

            const je = record.create({type:record.Type.JOURNAL_ENTRY,isDynamic:true});
            const subsidiary = invoice.getValue('subsidiary');
            if (subsidiary) je.setValue({fieldId:'subsidiary',value:subsidiary});
            je.setValue({fieldId:'memo',value:'Advance Billing COGS - Invoice '+invoiceId});

            je.selectNewLine({sublistId:'line'});
            je.setCurrentSublistValue({sublistId:'line',fieldId:'account',value:debitAccount});
            je.setCurrentSublistValue({sublistId:'line',fieldId:'debit',value:totalCost});
            je.setCurrentSublistValue({sublistId:'line',fieldId:'memo',value:'Advance Billing COGS - Invoice '+invoiceId});
            je.commitLine({sublistId:'line'});

            je.selectNewLine({sublistId:'line'});
            je.setCurrentSublistValue({sublistId:'line',fieldId:'account',value:creditAccount});
            je.setCurrentSublistValue({sublistId:'line',fieldId:'credit',value:totalCost});
            je.setCurrentSublistValue({sublistId:'line',fieldId:'memo',value:'Advance Billing COGS - Invoice '+invoiceId});
            je.commitLine({sublistId:'line'});

            const jeId = je.save();

            record.submitFields({
                type:record.Type.INVOICE,
                id:invoiceId,
                values:{custbody_related_je:jeId}
            });

            log.debug('Advance Billing Completed',{
                salesOrderId:so.id,
                invoiceId,
                journalEntryId:jeId,
                journalAmount:totalCost,
                debitAccount,
                creditAccount
            });

        } catch (e) {
            log.error('Advance Billing Error',{name:e.name,message:e.message,stack:e.stack});
            throw e;
        }
    };

    return {afterSubmit};
});