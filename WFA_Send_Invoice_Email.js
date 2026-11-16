/**
 * WFA_Send_Invoice_Email_TEST.js  -  TESTING VERSION (no script parameters)
 *
 * Every email goes ONLY to TEST_RECIPIENT below. Customers never receive anything.
 * The yellow box at the top of the email shows the real TO / CC it would use in live.
 *
 * Mode is detected automatically:
 *   Workflow event = Create  -> AUTO   (sends only if customer checkbox is checked)
 *   Anything else (button)   -> MANUAL (sends even if customer checkbox is unchecked)
 * Both modes: never sends if invoice total is $0, AUTO never sends twice.
 *
 * @NApiVersion 2.1
 * @NScriptType WorkflowActionScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/search', 'N/render', 'N/email', 'N/format'],
    (record, search, render, email, format) => {

        // ===================== HARDCODED SETTINGS =====================
        const TEMPLATE_ID = 8;                        // Email Template internal ID
        const SENDER_EMPLOYEE_ID = 8657;                 // <-- YOUR employee internal ID (number)
        const TEST_RECIPIENT = 'dsoni@oncloudconsulting.ca'; // <-- YOUR email address

        const DRY_RUN = false;            // true = log everything, send NOTHING, do not tick "email sent"
        const SET_SENT_FLAG_IN_TEST = true; // true = tick "email sent" after test send (to test "no duplicate")

        const CUST_AUTO_SEND = 'custentity_send_invoice_email';          // Customer checkbox
        const CUST_CC_FIELD = 'custentity_additional_external_inv_email'; // Customer CC emails
        const INV_SENT = 'custbody_email_sent';                          // Invoice checkbox
        const INV_SENT_DATE = '';   // Invoice Date/Time field ID if you have one, else leave ''
        // ==============================================================

        const TITLE = 'Send Invoice Email [TEST]';

        const selectValue = (v) => (Array.isArray(v) ? (v[0] ? v[0].value : '') : (v || ''));
        const isTrue = (v) => v === true || v === 'T';
        const splitEmails = (str) => {
            const seen = {};
            return String(str || '').split(/[;,\s]+/).map(s => s.trim())
                .filter(s => s && s.indexOf('@') > 0)
                .filter(s => (seen[s.toLowerCase()] ? false : (seen[s.toLowerCase()] = true)));
        };

        const onAction = (context) => {
            const invoiceId = context.newRecord ? context.newRecord.id : null;
            const eventType = String(context.type || '').toLowerCase();
            const mode = eventType === 'create' ? 'AUTO' : 'MANUAL';

            try {
                if (!invoiceId) return fail(null, 'No invoice ID in workflow context');
                if (!SENDER_EMPLOYEE_ID) return fail(invoiceId, 'SENDER_EMPLOYEE_ID is not set in the script');

                log.audit(TITLE, `Invoice ID ${invoiceId} | event: ${eventType || '(blank)'} | mode: ${mode}`);

                // ---------- Invoice ----------
                const inv = search.lookupFields({
                    type: search.Type.INVOICE, id: invoiceId,
                    columns: ['tranid', 'entity', 'email', 'total', INV_SENT]
                });
                const tranId = inv.tranid || String(invoiceId);
                const customerId = Number(selectValue(inv.entity));
                const total = parseFloat(inv.total) || 0;
                const alreadySent = isTrue(inv[INV_SENT]);
                if (!customerId) return fail(invoiceId, 'Invoice has no customer');

                // ---------- Customer ----------
                const cust = search.lookupFields({
                    type: search.Type.CUSTOMER, id: customerId,
                    columns: ['email', CUST_AUTO_SEND, CUST_CC_FIELD]
                });
                const custAutoSend = isTrue(cust[CUST_AUTO_SEND]);

                // ---------- Rules ----------
                if (total <= 0) return skip(tranId, `total is ${total.toFixed(2)} - $0 invoices are never emailed`);
                if (mode === 'AUTO') {
                    if (!custAutoSend) return skip(tranId, 'customer checkbox not checked');
                    if (alreadySent) return skip(tranId, 'already emailed');
                }

                // ---------- Real TO / CC (only shown in test) ----------
                let to = splitEmails(cust.email);
                if (!to.length) to = splitEmails(inv.email);
                if (!to.length) return fail(invoiceId, `Invoice ${tranId}: customer has no email address`);
                to = to.slice(0, 10);
                const toLower = to.map(e => e.toLowerCase());
                const cc = splitEmails(cust[CUST_CC_FIELD]).filter(e => toLower.indexOf(e.toLowerCase()) < 0).slice(0, 10);
                const ccText = cc.length ? cc.join(', ') : '(none)';

                // ---------- Subject/body + PDF ----------
                const merged = render.mergeEmail({
                    templateId: TEMPLATE_ID,
                    entity: { type: 'customer', id: customerId },
                    transactionId: Number(invoiceId)
                });
                const pdf = render.transaction({ entityId: Number(invoiceId), printMode: render.PrintMode.PDF });
                pdf.name = `Invoice_${tranId}.pdf`;

                log.audit(`${TITLE} Invoice ${tranId}`,
                    `Mode: ${mode} | Total: ${total.toFixed(2)} | Customer auto-send: ${custAutoSend} | ` +
                    `Already sent: ${alreadySent} | LIVE TO: ${to.join(', ')} | LIVE CC: ${ccText} | PDF: ${pdf.name} (${pdf.size} bytes)`);
                log.audit(`${TITLE} Subject`, merged.subject);
                log.debug(`${TITLE} Body (HTML)`, String(merged.body || '').substring(0, 3900));

                if (DRY_RUN) {
                    log.audit(TITLE, `Invoice ${tranId}: DRY RUN - nothing sent, "email sent" not ticked`);
                    return 'TEST: dry run, not sent';
                }

                // ---------- Send to TEST address only ----------
                email.send({
                    author: SENDER_EMPLOYEE_ID,
                    recipients: [TEST_RECIPIENT],
                    subject: `[TEST] ${merged.subject}`,
                    body: `<p style="background:#fff3cd;padding:8px;border:1px solid #e0c36c">` +
                        `<b>TEST EMAIL</b> - mode: ${mode}<br>Live TO: ${to.join(', ')}<br>Live CC: ${ccText}</p>` +
                        merged.body,
                    attachments: [pdf],
                    relatedRecords: { transactionId: Number(invoiceId) }
                });

                if (SET_SENT_FLAG_IN_TEST) markSent(invoiceId);

                log.audit(TITLE, `Invoice ${tranId}: SENT (${mode}) to TEST address ${TEST_RECIPIENT}`);
                return 'TEST: sent to test address';

            } catch (e) {
                return fail(invoiceId, `${e.name || 'Error'}: ${e.message || e}`);
            }
        };

        const markSent = (invoiceId) => {
            const values = { [INV_SENT]: true };
            if (INV_SENT_DATE) values[INV_SENT_DATE] = format.format({ value: new Date(), type: format.Type.DATETIME });
            record.submitFields({
                type: record.Type.INVOICE, id: invoiceId, values,
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });
        };

        const skip = (tranId, reason) => {
            log.audit(TITLE, `Invoice ${tranId}: SKIPPED - ${reason}`);
            return 'SKIPPED: ' + reason;
        };

        const fail = (invoiceId, msg) => {
            log.error(TITLE, `Invoice ID ${invoiceId}: ${msg}`);
            return 'ERROR: ' + msg;
        };

        return { onAction };
    });