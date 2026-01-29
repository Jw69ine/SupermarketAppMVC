    // controllers/RefundController.js
    const db = require('../db');

    const RefundController = {
    // Customer Service page: list user's orders + refund requests
    customerService: function (req, res) {
        const user = req.session.user;

        db.query(
        `SELECT o.id, o.total, o.orderDate, o.paymentMethod, o.status
        FROM orders o
        WHERE o.userId = ?
        ORDER BY o.orderDate DESC`,
        [user.id],
        (err, orders) => {
            if (err) {
            console.error(err);
            return res.status(500).send('Database error');
            }

            db.query(
            `SELECT rr.*
            FROM refund_requests rr
            WHERE rr.user_id = ?
            ORDER BY rr.created_at DESC`,
            [user.id],
            (err2, requests) => {
                if (err2) {
                console.error(err2);
                return res.status(500).send('Database error');
                }

                res.render('customerService', {
                user,
                orders,
                requests,
                messages: req.flash('messages'),
                errors: req.flash('error'),
                });
            }
            );
        }
        );
    },

    // User submits refund request
    createRequest: function (req, res) {
        const user = req.session.user;
        const orderId = Number(req.body.order_id);
        const reason = (req.body.reason || '').trim();

        if (!orderId || !reason) {
        req.flash('error', 'Please select an order and provide a reason.');
        return res.redirect('/customer-service');
        }

        // Only allow requesting refund for own paid orders
        db.query(
        `SELECT id, status FROM orders WHERE id=? AND userId=?`,
        [orderId, user.id],
        (err, rows) => {
            if (err || !rows.length) {
            req.flash('error', 'Order not found.');
            return res.redirect('/customer-service');
            }

            if (rows[0].status !== 'paid') {
            req.flash('error', 'Refund can only be requested for paid orders.');
            return res.redirect('/customer-service');
            }

            // Prevent duplicates (optional but nice)
            db.query(
            `SELECT id FROM refund_requests WHERE order_id=? AND user_id=? AND status IN ('pending','approved','refunded')`,
            [orderId, user.id],
            (err2, existing) => {
                if (err2) {
                console.error(err2);
                req.flash('error', 'Database error.');
                return res.redirect('/customer-service');
                }

                if (existing.length) {
                req.flash('error', 'Refund request already exists for this order.');
                return res.redirect('/customer-service');
                }

                db.query(
                `INSERT INTO refund_requests (order_id, user_id, reason, status)
                VALUES (?, ?, ?, 'pending')`,
                [orderId, user.id, reason.slice(0, 255)],
                (err3) => {
                    if (err3) {
                    console.error(err3);
                    req.flash('error', 'Failed to submit refund request.');
                    return res.redirect('/customer-service');
                    }
                    req.flash('messages', 'Refund request submitted. Admin will review it.');
                    return res.redirect('/customer-service');
                }
                );
            }
            );
        }
        );
    },
    };

    module.exports = RefundController;
