
/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record','N/search','N/runtime','N/log'], (record, search, runtime, log) => {

    const afterSubmit = (context) => {
        try {
            if (![context.UserEventType.CREATE,context.UserEventType.EDIT,context.UserEventType.SHIP].includes(context.type)) return;

            const ff = record.load({type:record.Type.ITEM_FULFILLMENT,id:context.newRecord.id});
            const soId = ff.getValue('createdfrom');
            if (!soId) return;

            const so = record.load({type:record.Type.SALES_ORDER,id:soId});
            const advance = so.getValue('custbody_advance_billing');
            const shipped = ff.getValue('shipstatus') === 'C';
            const ifNumber = ff.getValue('tranid');

            // Do nothing unless Advance Billing is checked or IF is Shipped
            if (!advance && !shipped) return;

            // Find existing invoice for this IF
            const existing = search.create({
                type:search.Type.INVOICE,
                filters:[
                    ['createdfrom','anyof',soId],
                    'AND',['mainline','is','T'],
                    'AND',['custbody_sourced_if','is',ifNumber]
                ],
                columns:['internalid','custbody_related_je']
            }).run().getRange({start:0,end:1});

            if (existing.length) {
                const invoiceId = existing[0].id;
                const jeId = existing[0].getValue('custbody_related_je');

                // Reverse Advance Billing JE when IF becomes Shipped
                if (shipped && jeId) {
                    const memo = 'Advance Billing Reversal - Invoice '+invoiceId;
                    const reversed = search.create({
                        type:search.Type.JOURNAL_ENTRY,
                        filters:[['mainline','is','T'],'AND',['memo','is',memo]],
                        columns:['internalid']
                    }).run().getRange({start:0,end:1});

                    if (!reversed.length) {
                        const original = record.load({type:record.Type.JOURNAL_ENTRY,id:jeId});
                        const je = record.create({type:record.Type.JOURNAL_ENTRY,isDynamic:true});

                        for (const field of ['subsidiary','currency','exchangerate']) {
                            const value = original.getValue(field);
                            if (value) je.setValue({fieldId:field,value:value});
                        }

                        je.setValue({fieldId:'memo',value:memo});

                        for (let i=0; i<original.getLineCount({sublistId:'line'}); i++) {
                            const account = original.getSublistValue({sublistId:'line',fieldId:'account',line:i});
                            const debit = +original.getSublistValue({sublistId:'line',fieldId:'debit',line:i}) || 0;
                            const credit = +original.getSublistValue({sublistId:'line',fieldId:'credit',line:i}) || 0;

                            je.selectNewLine({sublistId:'line'});
                            je.setCurrentSublistValue({sublistId:'line',fieldId:'account',value:account});
                            if (debit) je.setCurrentSublistValue({sublistId:'line',fieldId:'credit',value:debit});
                            if (credit) je.setCurrentSublistValue({sublistId:'line',fieldId:'debit',value:credit});
                            je.commitLine({sublistId:'line'});
                        }

                        const reversalId = je.save();
                        log.debug('COGS JE Reversed',{ifNumber,invoiceId,jeId,reversalId});
                    }
                }
                return;
            }

            // Get IF line quantities
            const lines = {};
            for (let i=0; i<ff.getLineCount({sublistId:'item'}); i++) {
                const line = ff.getSublistValue({sublistId:'item',fieldId:'orderline',line:i});
                const qty = +ff.getSublistValue({sublistId:'item',fieldId:'quantity',line:i}) || 0;
                if (line && qty > 0) lines[line] = (lines[line] || 0) + qty;
            }
            if (!Object.keys(lines).length) return;

            const invoice = record.transform({
                fromType:record.Type.SALES_ORDER,
                fromId:soId,
                toType:record.Type.INVOICE
            });

            invoice.setValue({fieldId:'custbody_sourced_if',value:ifNumber});
            invoice.setValue({
                fieldId:'memo',
                value:(shipped ? 'Normal Shipping' : 'Advance Billing')+' - IF '+ifNumber+' (ID '+ff.id+')'
            });

            let totalCost = 0;
            let matched = 0;

            for (let i=invoice.getLineCount({sublistId:'item'})-1; i>=0; i--) {
                const line = invoice.getSublistValue({sublistId:'item',fieldId:'orderline',line:i});

                if (!lines[line]) {
                    invoice.removeLine({sublistId:'item',line:i});
                    continue;
                }

                const qty = lines[line];
                matched++;
                invoice.setSublistValue({sublistId:'item',fieldId:'quantity',line:i,value:qty});

                if (!shipped) {
                    const itemId = invoice.getSublistValue({sublistId:'item',fieldId:'item',line:i});
                    const item = search.lookupFields({
                        type:search.Type.ITEM,id:itemId,
                        columns:['averagecost','lastpurchaseprice']
                    });

                    const cost = (+item.averagecost) || (+item.lastpurchaseprice) || 1;
                    totalCost += qty * cost;
                }
            }

            if (!matched) return;
            if (matched !== Object.keys(lines).length)
                throw Error('Some IF lines are missing from invoice transform');

            const invoiceId = invoice.save();

            // Normal Shipping: No JE
            if (shipped) {
                log.debug('Normal Invoice Created',{ifNumber,invoiceId});
                return;
            }

            // Advance Billing: Create COGS JE
            const script = runtime.getCurrentScript();
            const debitAccount = +script.getParameter({name:'custscript_je_debit_account'});
            const creditAccount = +script.getParameter({name:'custscript_je_credit_account'});

            if (!debitAccount || !creditAccount) throw Error('JE account parameters missing');
            if (totalCost <= 0) throw Error('Invalid COGS amount');

            const je = record.create({type:record.Type.JOURNAL_ENTRY,isDynamic:true});
            const subsidiary = invoice.getValue('subsidiary');
            if (subsidiary) je.setValue({fieldId:'subsidiary',value:subsidiary});
            je.setValue({fieldId:'memo',value:'Advance Billing COGS - Invoice '+invoiceId});

            for (const entry of [
                {account:debitAccount,field:'debit'},
                {account:creditAccount,field:'credit'}
            ]) {
                je.selectNewLine({sublistId:'line'});
                je.setCurrentSublistValue({sublistId:'line',fieldId:'account',value:entry.account});
                je.setCurrentSublistValue({sublistId:'line',fieldId:entry.field,value:totalCost});
                je.setCurrentSublistValue({sublistId:'line',fieldId:'memo',value:'Advance Billing COGS - Invoice '+invoiceId});
                je.commitLine({sublistId:'line'});
            }

            const jeId = je.save();

            record.submitFields({
                type:record.Type.INVOICE,id:invoiceId,
                values:{custbody_related_je:jeId}
            });

            log.debug('Advance Billing Completed',{ifNumber,invoiceId,jeId,totalCost});

        } catch (e) {
            log.error('IF Invoicing Error',{name:e.name,message:e.message,stack:e.stack});
            throw e;
        }
    };

    return {afterSubmit};
});
