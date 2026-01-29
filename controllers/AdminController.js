    // controllers/AdminController.js
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
    // items should contain: [{ productId, quantity, ... }, ...]
    // Restock: quantity = quantity + purchasedQty [web:53][web:54]
    const tasks = items.map(
        (item) =>
        new Promise((resolve, reject) => {
            const productId = item.productId ?? item.id; // fallback if your cart stores id instead of productId
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

            // payment id fallback: provider_payment_id or transaction_id
            const paymentId = rr.provider_payment_id || rr.transaction_id;

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
                // Stripe refund create using payment_intent [web:5]
                const refund = await stripe.refunds.create({
                payment_intent: paymentId,
                reason: 'requested_by_customer',
                });

                providerRefundId = refund.id;
                providerRefundStatus = refund.status;
            } else if (rr.provider === 'PAYPAL') {
                // Full refund: pass null amount (your paypal.js supports this)
                const refund = await paypal.refundCapturedPayment(
                paymentId, // capture_id
                null, // full refund
                rr.currency || 'SGD',
                `Refund approved by ${adminUser.username || 'admin'}`
                );

                providerRefundId = refund.id;
                providerRefundStatus = refund.status;
            } else {
                throw new Error('Unsupported provider: ' + rr.provider);
            }

            // 2) Restore stock based on order items JSON
            const items = safeJsonParse(rr.order_items || '[]', []);
            await restoreStockFromOrderItems(items);

            // 3) Insert refund record (if you have refunds table)
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

            // 5) Email user (do not block success if email fails)
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
