/**
 * WFA_Send_Invoice_Email.js
 *
 * Workflow Action Script - sends the Invoice email using an Email Template
 * and attaches the Invoice PDF.
 *
 * Used by the "Invoice Email Automation" workflow in two ways:
 *   AUTO   - runs after an invoice is created. Sends only if the Customer has
 *            "Send Invoice Email Automatically" checked AND the invoice was not
 *            already emailed.
 *   MANUAL - runs when the user clicks the "Send Invoice Email" button.
 *            Always sends (and can resend), even if the customer is not checked.
 *
 * Script parameters (create on the Script record, Parameters subtab):
 *   custscript_inv_email_mode      Free-Form Text   AUTO or MANUAL (set per workflow action)
 *   custscript_inv_email_template  Integer Number   Internal ID of the Email Template
 *   custscript_inv_email_sender    List/Record (Employee)  Employee shown as the sender
 *
 * Custom fields used:
 *   custentity_auto_send_invoice   Customer checkbox
 *   custbody_inv_email_sent        Invoice checkbox
 *   custbody_inv_email_sent_date   Invoice Date/Time
 *
 * Returns a text result: SENT / SKIPPED / ERROR (set Return Type = Free-Form Text
 * on the Script record if you want to store it in a workflow field).
 *
 * @NApiVersion 2.1
 * @NScriptType WorkflowActionScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/search', 'N/render', 'N/email', 'N/runtime', 'N/format'],
    (record, search, render, email, runtime, format) => {

        const PARAM = {
            MODE: 'custscript_inv_email_mode',
            TEMPLATE: 'custscript_inv_email_template',
            SENDER: 'custscript_inv_email_sender'
        };

        const FIELD = {
            CUST_AUTO_SEND: 'custentity_auto_send_invoice',
            INV_SENT: 'custbody_inv_email_sent',
            INV_SENT_DATE: 'custbody_inv_email_sent_date'
        };

        /** Lookup helper: returns the value of a select field from lookupFields output */
        const selectValue = (v) => (Array.isArray(v) ? (v[0] ? v[0].value : '') : (v || ''));

        /** Split "a@x.com; b@y.com, c@z.com" into a clean array */
        const splitEmails = (str) => String(str || '')
            .split(/[;,]/)
            .map(s => s.trim())
            .filter(s => s && s.indexOf('@') > 0);

        const isTrue = (v) => v === true || v === 'T';

        const onAction = (context) => {
            const title = 'Send Invoice Email';
            const invoiceId = context.newRecord ? context.newRecord.id : null;

            try {
                if (!invoiceId) {
                    log.error(title, 'No invoice ID in workflow context');
                    return 'ERROR: no invoice id';
                }

                // ---------- Parameters ----------
                const script = runtime.getCurrentScript();
                const mode = String(script.getParameter({ name: PARAM.MODE }) || 'AUTO').trim().toUpperCase();
                const templateId = Number(script.getParameter({ name: PARAM.TEMPLATE }));
                let senderId = Number(script.getParameter({ name: PARAM.SENDER }));

                if (!senderId) {
                    // Fallback to current user (manual click). For scripted / system
                    // runs the current user may be -4, so the Sender parameter is required there.
                    const userId = Number(runtime.getCurrentUser().id);
                    if (userId > 0) senderId = userId;
                }

                if (!templateId) return fail(invoiceId, 'Email Template parameter is empty');
                if (!senderId) return fail(invoiceId, 'Sender Employee parameter is empty');

                // ---------- Read invoice fresh from DB (avoid stale values) ----------
                const inv = search.lookupFields({
                    type: search.Type.INVOICE,
                    id: invoiceId,
                    columns: ['tranid', 'entity', 'email', FIELD.INV_SENT]
                });

                const tranId = inv.tranid || String(invoiceId);
                const customerId = Number(selectValue(inv.entity));
                const alreadySent = isTrue(inv[FIELD.INV_SENT]);

                if (!customerId) return fail(invoiceId, 'Invoice has no customer');

                // ---------- Read customer ----------
                const cust = search.lookupFields({
                    type: search.Type.CUSTOMER,
                    id: customerId,
                    columns: ['email', FIELD.CUST_AUTO_SEND]
                });
                const custAutoSend = isTrue(cust[FIELD.CUST_AUTO_SEND]);

                // ---------- AUTO rules ----------
                if (mode === 'AUTO') {
                    if (!custAutoSend) {
                        log.audit(title, `Invoice ${tranId}: SKIPPED - customer not set to auto-send`);
                        return 'SKIPPED: customer not opted in';
                    }
                    if (alreadySent) {
                        log.audit(title, `Invoice ${tranId}: SKIPPED - already emailed`);
                        return 'SKIPPED: already sent';
                    }
                }

                // ---------- Recipients ----------
                // Invoice "Email" field first (can hold several addresses), else the customer email
                let recipients = splitEmails(inv.email);
                if (!recipients.length) recipients = splitEmails(cust.email);
                if (!recipients.length) return fail(invoiceId, `Invoice ${tranId}: no email address on invoice or customer`);
                recipients = recipients.slice(0, 10); // email.send limit

                // ---------- Merge template (subject + body) ----------
                const merged = render.mergeEmail({
                    templateId: templateId,
                    entity: { type: 'customer', id: customerId },
                    transactionId: Number(invoiceId)
                });

                // ---------- Invoice PDF (uses the form's print template) ----------
                const pdf = render.transaction({
                    entityId: Number(invoiceId),
                    printMode: render.PrintMode.PDF
                });
                pdf.name = `Invoice_${tranId}.pdf`;

                // ---------- Send ----------
                email.send({
                    author: senderId,
                    recipients: recipients,
                    subject: merged.subject,
                    body: merged.body,
                    attachments: [pdf],
                    relatedRecords: {
                        transactionId: Number(invoiceId), // shows under Communication tab on the invoice
                        entityId: customerId
                    }
                });

                // ---------- Mark as sent (only after successful send) ----------
                record.submitFields({
                    type: record.Type.INVOICE,
                    id: invoiceId,
                    values: {
                        [FIELD.INV_SENT]: true,
                        [FIELD.INV_SENT_DATE]: format.format({ value: new Date(), type: format.Type.DATETIME })
                    },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });

                log.audit(title, `Invoice ${tranId}: SENT (${mode}) to ${recipients.join(', ')}`);
                return 'SENT';

            } catch (e) {
                // Never throw: invoice creation must stay successful even if the email fails.
                return fail(invoiceId, `${e.name || 'Error'}: ${e.message || e}`);
            }
        };

        const fail = (invoiceId, msg) => {
            log.error('Send Invoice Email', `Invoice ID ${invoiceId}: ${msg}`);
            return 'ERROR: ' + msg;
        };

        return { onAction };
    });
