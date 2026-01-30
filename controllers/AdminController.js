    // controllers/AdminController.js
    require('dotenv').config();

    const Product = require('../models/Product');
    const Order = require('../models/Order');

    const db = require('../db');
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const paypal = require('../services/paypal');

    const nodemailer = require('nodemailer');

    // ---------------- Email helpers ----------------
    let mailTransporter = null;

    function getMailTransporter() {
    if (mailTransporter) return mailTransporter;

    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;

    if (!user || !pass) {
        throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD in environment variables.');
    }

    mailTransporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass },
    });

    return mailTransporter;
    }

    async function sendRefundApprovedEmail({ toEmail, username, orderId, refundRequestId }) {
    if (!toEmail) return;

    const transporter = getMailTransporter();

    const subject = `Refund approved (Order #${orderId})`;
    const text =
        `Hi ${username || 'Customer'},\n\n` +
        `Your refund request (Request #${refundRequestId}) has been approved for Order #${orderId}.\n` +
        `The refund will be processed within 3 working days.\n\n` +
        `Thank you,\n` +
        `Supermarket Support`;

    return transporter.sendMail({
        from: `"Supermarket Support" <${process.env.GMAIL_USER}>`,
        to: toEmail,
        subject,
        text,
    });
    }

    // ---------------- HitPay helpers ----------------
    function getHitpayBaseUrl() {
    return process.env.HITPAY_BASE_URL || 'https://api.sandbox.hit-pay.com';
    }

    function requireHitpayEnv() {
    if (!process.env.HITPAY_API_KEY) throw new Error('Missing HITPAY_API_KEY in .env');
    }

    // Get payment request status (to verify status and attempt to extract payment_id). [page:1]
    async function getHitpayPaymentRequestStatus(requestId) {
    requireHitpayEnv();

    const resp = await fetch(`${getHitpayBaseUrl()}/v1/payment-requests/${encodeURIComponent(requestId)}`, {
        method: 'GET',
        headers: { 'X-BUSINESS-API-KEY': process.env.HITPAY_API_KEY },
    });

    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, data };
    }

    // Try to extract a refundable payment/charge id from the Payment Request object.
    // NOTE: Different HitPay setups may expose it under different keys; this tries common shapes. [page:1]
    function extractHitpayPaymentIdFromPaymentRequest(pr) {
    if (!pr || typeof pr !== 'object') return null;

    return (
        pr.payment_id ||
        pr.charge_id ||
        pr.payment?.id ||
        pr.charge?.id ||
        (Array.isArray(pr.payments) ? pr.payments[0]?.id : null) ||
        (Array.isArray(pr.charges) ? pr.charges[0]?.id : null) ||
        null
    );
    }

    // ---------------- Utility helpers ----------------
    function safeJsonParse(s, fallback = []) {
    try {
        const v = JSON.parse(s);
        return Array.isArray(v) ? v : fallback;
    } catch {
        return fallback;
    }
    }

    function restoreStockFromOrderItems(items) {
    const tasks = items.map(
        (item) =>
        new Promise((resolve, reject) => {
            const productId = item.productId ?? item.id;
            const qty = Number(item.quantity);

            if (!productId || !Number.isFinite(qty) || qty <= 0) return resolve();

            db.query(
            'UPDATE products SET quantity = quantity + ? WHERE id = ?',
            [qty, productId],
            (err) => (err ? reject(err) : resolve())
            );
        })
    );

    return Promise.all(tasks);
    }

    // ---------------- Controller ----------------
    const AdminController = {
    dashboard: function (req, res) {
        Product.getAll(function (err, products) {
        if (err) return res.status(500).send('Database error');
        Order.getAll(function (err2, orders) {
            if (err2) return res.status(500).send('Database error');

            res.render('adminDashboard', {
            user: req.session.user,
            products: products,
            orders: orders,
            messages: req.flash('messages'),
            errors: req.flash('error'),
            });
        });
        });
    },

    // List refund requests
    refundList: function (req, res) {
        db.query(
        `SELECT rr.*, u.username, u.email, o.total AS order_total, o.paymentMethod, o.orderDate,
                p.provider, p.provider_payment_id, p.provider_order_id, p.transaction_id, p.amount, p.currency
        FROM refund_requests rr
        JOIN users u ON u.id = rr.user_id
        JOIN orders o ON o.id = rr.order_id
        LEFT JOIN payment p ON p.order_id = rr.order_id
        ORDER BY rr.created_at DESC`,
        [],
        (err, rows) => {
            if (err) {
            console.error(err);
            return res.status(500).send('Database error');
            }

            res.render('adminRefunds', {
            user: req.session.user,
            refunds: rows,
            messages: req.flash('messages'),
            errors: req.flash('error'),
            });
        }
        );
    },

    approveRefund: function (req, res) {
        const refundRequestId = req.params.id;
        const adminUser = req.session.user;

        db.query(
        `SELECT rr.*,
                u.username, u.email,
                o.id AS order_id, o.items AS order_items, o.total AS order_total,
                p.provider, p.provider_payment_id, p.provider_order_id, p.transaction_id, p.amount, p.currency
        FROM refund_requests rr
        JOIN users u ON u.id = rr.user_id
        JOIN orders o ON o.id = rr.order_id
        LEFT JOIN payment p ON p.order_id = rr.order_id
        WHERE rr.id = ?`,
        [refundRequestId],
        async (err, rows) => {
            if (err || !rows.length) {
            console.error(err);
            req.flash('error', 'Refund request not found.');
            return res.redirect('/admin/refunds');
            }

            const rr = rows[0];

            if (rr.status !== 'pending') {
            req.flash('error', 'Refund request is not pending.');
            return res.redirect('/admin/refunds');
            }

            // Primary ID to refund: provider_payment_id; fallback: transaction_id
            let paymentId = rr.provider_payment_id || rr.transaction_id;

            if (!rr.provider || !paymentId) {
            req.flash(
                'error',
                'Cannot approve: missing payment info (provider/payment id). Ensure payment row is inserted after checkout.'
            );
            return res.redirect('/admin/refunds');
            }

            try {
            // 1) Refund via provider
            let providerRefundId = null;
            let providerRefundStatus = null;

            if (rr.provider === 'STRIPE') {
                const refund = await stripe.refunds.create({
                payment_intent: paymentId,
                reason: 'requested_by_customer',
                });

                providerRefundId = refund.id;
                providerRefundStatus = refund.status;
            } else if (rr.provider === 'PAYPAL') {
                const refund = await paypal.refundCapturedPayment(
                paymentId,
                null,
                rr.currency || 'SGD',
                `Refund approved by ${adminUser.username || 'admin'}`
                );

                providerRefundId = refund.id;
                providerRefundStatus = refund.status;
            } else if (rr.provider === 'HITPAY') {
                requireHitpayEnv();

                // Your DB currently stores payment_request_id in provider_payment_id (same as provider_order_id). [file:250]
                // HitPay refund requires "payment_id" of successful payment (UUID). [page:0]
                const paymentRequestId = rr.provider_order_id;

                // If provider_payment_id looks like it is just payment_request_id, try to resolve the real payment_id first
                if (paymentRequestId && rr.provider_payment_id && rr.provider_payment_id === paymentRequestId) {
                const pr = await getHitpayPaymentRequestStatus(paymentRequestId); // [page:1]
                if (!pr.ok) throw new Error(pr.data?.message || 'HitPay payment request lookup failed');

                const status = String(pr.data?.status || '').toLowerCase();
                if (status !== 'completed') {
                    throw new Error('HitPay payment is not completed yet (status=' + status + ')');
                }

                const resolvedPaymentId = extractHitpayPaymentIdFromPaymentRequest(pr.data);
                if (!resolvedPaymentId) {
                    throw new Error(
                    'Cannot refund HitPay: payment_id not found from payment request status response. ' +
                    'Enable webhook to store charge/payment id.'
                    );
                }

                // Save it back so future refunds work without extra API calls
                await new Promise((resolve, reject) => {
                    db.query(
                    `UPDATE payment SET provider_payment_id=? WHERE provider='HITPAY' AND provider_order_id=?`,
                    [resolvedPaymentId, paymentRequestId],
                    (e) => (e ? reject(e) : resolve())
                    );
                });

                paymentId = resolvedPaymentId;
                }

                const amount = rr.amount || rr.order_total;

                const resp = await fetch(`${getHitpayBaseUrl()}/v1/refund`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-BUSINESS-API-KEY': process.env.HITPAY_API_KEY,
                },
                body: JSON.stringify({
                    payment_id: paymentId,
                    amount: amount,
                }),
                });

                const refund = await resp.json().catch(() => ({}));
                if (!resp.ok) throw new Error(refund?.message || 'HitPay refund failed'); // [page:0]

                providerRefundId = refund.id;
                providerRefundStatus = refund.status; // e.g. "succeeded" [page:0]
            } else {
                throw new Error('Unsupported provider: ' + rr.provider);
            }

            // 2) Restore stock
            const items = safeJsonParse(rr.order_items || '[]', []);
            await restoreStockFromOrderItems(items);

            // 3) Insert refund record
            db.query(
                `INSERT INTO refunds (refund_request_id, provider, provider_refund_id, amount, currency, status)
                VALUES (?, ?, ?, ?, ?, ?)`,
                [
                refundRequestId,
                rr.provider,
                providerRefundId,
                rr.amount || rr.order_total || null,
                rr.currency || null,
                providerRefundStatus || 'COMPLETED',
                ],
                (e1) => {
                if (e1) console.error('Insert refunds failed:', e1);
                }
            );

            // 4) Update statuses
            db.query(
                `UPDATE refund_requests
                SET status='refunded', admin_note=?, decided_at=NOW()
                WHERE id=?`,
                [`Approved by ${adminUser.username || 'admin'}`, refundRequestId],
                (e2) => {
                if (e2) console.error('Update refund_requests failed:', e2);
                }
            );

            db.query(
                `UPDATE orders SET status='refunded' WHERE id=?`,
                [rr.order_id],
                (e3) => {
                if (e3) console.error('Update orders failed:', e3);
                }
            );

            // 5) Email user
            try {
                await sendRefundApprovedEmail({
                toEmail: rr.email,
                username: rr.username,
                orderId: rr.order_id,
                refundRequestId,
                });
            } catch (mailErr) {
                console.error('Refund email failed:', mailErr);
            }

            req.flash('messages', 'Refund approved: payment refunded, stock restored, email sent.');
            return res.redirect('/admin/refunds');
            } catch (e) {
            console.error('Refund failed:', e);
            req.flash('error', 'Refund failed: ' + (e.message || 'unknown error'));
            return res.redirect('/admin/refunds');
            }
        }
        );
    },

    rejectRefund: function (req, res) {
        const refundRequestId = req.params.id;
        const note = (req.body.admin_note || 'Rejected by admin').toString().slice(0, 255);

        db.query(
        `UPDATE refund_requests
        SET status='rejected', admin_note=?, decided_at=NOW()
        WHERE id=? AND status='pending'`,
        [note, refundRequestId],
        (err, result) => {
            if (err) {
            console.error(err);
            req.flash('error', 'Reject failed.');
            return res.redirect('/admin/refunds');
            }

            if (result.affectedRows === 0) {
            req.flash('error', 'Refund request not pending / not found.');
            return res.redirect('/admin/refunds');
            }

            req.flash('messages', 'Refund rejected.');
            return res.redirect('/admin/refunds');
        }
        );
    },
    };

    module.exports = AdminController;
