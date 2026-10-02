/**
* Copyright (c) 2024, Oracle and/or its affiliates.
* 500 Oracle Parkway Redwood Shores, CA 94065
* All Rights Reserved.
*
* This software is the confidential and proprietary information of
* NetSuite, Inc. ("Confidential Information"). You shall not
* disclose such Confidential Information and shall use it only in
* accordance with the terms of the license agreement you entered into
* with NetSuite.
*
*   Version    Date            Author              Remarks
*   1.00       18 Oct 2024     Juan M. Silva       Initial Version
*   1.01       4 Jun 2025      Juan M. Silva       Added logic to check {creditholdoverride} value first
*   1.02       30 Jul 2025     Juan M. Silva       Added function validateCreditLimit.
*
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/error', 'N/record', 'N/runtime', 'N/search'],
    /**
 * @param{error} error
 * @param{record} record
 * @param{runtime} runtime
 * @param{search} search
 */
    (error, record, runtime, search) => {

        /**
         * Defines the function definition that is executed before record is submitted.
         * @param {Object} scriptContext
         * @param {Record} scriptContext.newRecord - New record
         * @param {Record} scriptContext.oldRecord - Old record
         * @param {string} scriptContext.type - Trigger type; use values from the context.UserEventType enum
         * @since 2015.2
         */
        const beforeSubmit = (scriptContext) => {
            const strLog = 'beforeSubmit';
            try {
                const strMsgParam = runtime.getCurrentScript().getParameter('custscript_acs_param_msg');
                const strStatusParam = runtime.getCurrentScript().getParameter('custscript_acs_if_status');
                if (!strMsgParam || !strStatusParam) {
                    log.error(strLog, 'Missing paramter');
                    return;
                }
                const userObj = runtime.getCurrentUser();
                const userPref = userObj.getPreference({
                    name: 'CUSTCREDLIMHANDLING'
                });
                log.debug(strLog, 'User preference for CUSTCREDLIMHANDLING: ' + userPref);

                const newRec = scriptContext.newRecord;
                const contextType = scriptContext.type;
                const recType = newRec.type;
                log.debug(strLog, `${recType} - ${contextType}`)

                if (contextType === scriptContext.UserEventType.SHIP || contextType === scriptContext.UserEventType.EDIT || contextType === scriptContext.UserEventType.CREATE) {

                    const customerId = newRec.getValue('entity');
                    const customerRec = record.load({
                        type: record.Type.CUSTOMER,
                        id: customerId,
                        isDynamic: false
                    })
                    let creditHold = customerRec.getValue('creditholdoverride');
                    log.debug(strLog, `CreditHold - ${creditHold}`)

                    let boolValidateLimit = validateCreditLimit(customerRec);
                    log.debug(strLog, `Over credit limit:  ${boolValidateLimit}`);

                    if (creditHold && boolValidateLimit) {
                        let custom_error = error.create({
                            name: 'Error',
                            message: strMsgParam,
                            notifyOff: false
                        });
                        if (creditHold == 'ON') throw custom_error;
                        if (creditHold == 'AUTO' && recType == record.Type.ITEM_FULFILLMENT) {
                            let changedStatus = true;
                            const newStatus = newRec.getValue('shipstatus');
                            let oldStatus;
                            const oldRec = scriptContext.oldRecord;

                            if (oldRec) {
                                oldStatus = oldRec.getValue('shipstatus');
                            }

                            if (newStatus !== strStatusParam || oldStatus == newStatus) {
                                changedStatus = false;
                            }

                            if (changedStatus) throw custom_error;
                        }
                    }
                }
            } catch (e) {
                throw e.message;
            }

        }

        const validateCreditLimit = (customerRec) => {
            try {
                let balance = customerRec.getValue('balance');
                let unbilledOrders = customerRec.getValue('unbilledorders');
                let creditLimit = customerRec.getValue('creditlimit');

                balance = parseFloat(balance);
                unbilledOrders = parseFloat(unbilledOrders);
                creditLimit = parseFloat(creditLimit);
                if (balance && unbilledOrders && creditLimit) return ((creditLimit + unbilledOrders - creditLimit) > 0);
                return false;
            } catch (e) {
                log.error('isOnHold', e.message);
            }
        }

        return { beforeSubmit }

    });
