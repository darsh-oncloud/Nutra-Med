/**
 * WFA_Send_Invoice_Email.js  -  FINAL (button only, no parameters, no library)
 *
 * Runs when the user clicks the "Send Email" button on the Invoice.
 *   - Sends even if the customer checkbox is NOT checked (manual send)
 *   - Never sends a $0 invoice
 *   - TO = customer email (fallback: invoice email)
 *   - CC = customer "additional external invoice emails"
 *   - Attaches the invoice PDF, subject/body from Email Template
 *   - Ticks "Email Sent" on the invoice after a successful send
 *
 * @NApiVersion 2.1
 * @NScriptType WorkflowActionScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/search', 'N/render', 'N/email'],
    (record, search, render, email) => {

        // ===================== HARDCODED SETTINGS =====================
        const TEMPLATE_ID = 8;                 // Email Template internal ID
        const SENDER_EMPLOYEE_ID = 8664;       // AR employee (From)
        const TEST_RECIPIENT = '';             // put your email here to test; '' = LIVE (customer)

        const CUST_CC_FIELD = 'custentity_additional_external_inv_email';
        const INV_SENT = 'custbody_email_sent';
        // ==============================================================

        const TITLE = 'Send Invoice Email (Button)';

        const isTrue = (v) => v === true || v === 'T';
        const selectValue = (v) => (Array.isArray(v) ? (v[0] ? v[0].value : '') : (v || ''));
        const splitEmails = (str) => {
            const seen = {};
            return String(str || '').split(/[;,\s]+/).map(s => s.trim())
                .filter(s => s && s.indexOf('@') > 0)
                .filter(s => (seen[s.toLowerCase()] ? false : (seen[s.toLowerCase()] = true)));
        };

        const onAction = (context) => {
            const invoiceId = Number(context.newRecord.id);

            try {
                const inv = search.lookupFields({
                    type: search.Type.INVOICE, id: invoiceId,
                    columns: ['tranid', 'entity', 'email', 'total']
                });
                const tranId = inv.tranid || String(invoiceId);
                const customerId = Number(selectValue(inv.entity));
                const total = parseFloat(inv.total) || 0;

                if (total <= 0) {
                    log.audit(TITLE, `Invoice ${tranId}: SKIPPED - $0 invoice`);
                    return 'SKIPPED: $0 invoice';
                }

                const cust = search.lookupFields({
                    type: search.Type.CUSTOMER, id: customerId,
                    columns: ['email', CUST_CC_FIELD]
                });

                let to = splitEmails(cust.email);
                if (!to.length) to = splitEmails(inv.email);
                if (!to.length) {
                    log.error(TITLE, `Invoice ${tranId}: customer has no email address`);
                    return 'ERROR: no email address';
                }
                to = to.slice(0, 10);
                const toLower = to.map(e => e.toLowerCase());
                const cc = splitEmails(cust[CUST_CC_FIELD]).filter(e => toLower.indexOf(e.toLowerCase()) < 0).slice(0, 10);

                const merged = render.mergeEmail({
                    templateId: TEMPLATE_ID,
                    entity: { type: 'customer', id: customerId },
                    transactionId: invoiceId
                });
                const pdf = render.transaction({ entityId: invoiceId, printMode: render.PrintMode.PDF });
                pdf.name = `Invoice_${tranId}.pdf`;

                const opts = {
                    author: SENDER_EMPLOYEE_ID,
                    recipients: to,
                    subject: merged.subject,
                    body: merged.body,
                    attachments: [pdf],
                    relatedRecords: { transactionId: invoiceId, entityId: customerId }
                };
                if (cc.length) opts.cc = cc;

                if (TEST_RECIPIENT) {
                    opts.recipients = [TEST_RECIPIENT];
                    delete opts.cc;
                    opts.subject = '[TEST] ' + opts.subject;
                    opts.body = `<p style="background:#fff3cd;padding:8px">TEST - Live TO: ${to.join(', ')} | Live CC: ${cc.join(', ') || '(none)'}</p>` + opts.body;
                }

                email.send(opts);

                record.submitFields({
                    type: record.Type.INVOICE, id: invoiceId,
                    values: { [INV_SENT]: true },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });

                log.audit(TITLE, `Invoice ${tranId}: SENT | TO: ${opts.recipients.join(', ')} | CC: ${(opts.cc || []).join(', ') || '(none)'}`);
                return 'SENT';

            } catch (e) {
                log.error(TITLE, `Invoice ID ${invoiceId}: ${e.name} - ${e.message}`);
                return 'ERROR: ' + e.message;
            }
        };

        return { onAction };
    });