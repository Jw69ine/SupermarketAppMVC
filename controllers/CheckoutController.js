    // controllers/CheckoutController.js
    const db = require('../db');
    const path = require('path');
    const fs = require('fs');
    const PDFDocument = require('pdfkit');
    const CartController = require('./CartController');
    const nodemailer = require('nodemailer');
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    /**
     * Helper: format JS Date -> MySQL DATETIME 'YYYY-MM-DD HH:mm:ss'
     */
    function formatDateForSQL(dateObj) {
    const pad = (n) => (n < 10 ? '0' + n : n);
    return (
        dateObj.getFullYear() +
        '-' +
        pad(dateObj.getMonth() + 1) +
        '-' +
        pad(dateObj.getDate()) +
        ' ' +
        pad(dateObj.getHours()) +
        ':' +
        pad(dateObj.getMinutes()) +
        ':' +
        pad(dateObj.getSeconds())
    );
    }

    function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    }

    /**
     * Generates a receipt PDF using pdfkit.
     */
    function generateReceiptPDF(order, user, filepath) {
    return new Promise((resolve, reject) => {
        ensureDir(path.dirname(filepath));

        const doc = new PDFDocument({ margin: 50 });
        const stream = fs.createWriteStream(filepath);

        doc.pipe(stream);

        // Header
        doc.fontSize(26).font('Helvetica-Bold').text('SUPERMARKET', { align: 'center' });
        doc.moveDown(0.2);

        // Date below title
        doc
        .fontSize(12)
        .font('Helvetica')
        .fillColor('#666')
        .text(`Date: ${order.orderDate}`, { align: 'center' })
        .fillColor('#000')
        .moveDown(0.2);

        // Official Receipt subtitle
        doc
        .fontSize(12)
        .font('Helvetica')
        .fillColor('#666')
        .text('Official Receipt', { align: 'center' })
        .fillColor('#000')
        .moveDown(0.6);

        // Divider
        doc.strokeColor('#333').lineWidth(1);
        doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
        doc.moveDown(0.4);

        // Receipt details
        doc.fontSize(12).font('Helvetica');
        doc.text(`Receipt #: ${order.id}`);
        doc.text(`Customer: ${user.username}`);
        doc.text(`Email: ${user.email}`);
        doc.text(`Payment Method: ${order.paymentMethod}`);
        doc.moveDown(0.6);

        // Divider
        doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
        doc.moveDown(0.5);

        // Items table header
        const itemStartY = doc.y;
        doc.fontSize(12).font('Helvetica-Bold');
        doc
        .text('Item', 50, itemStartY, { width: 200 })
        .text('Qty', 250, itemStartY, { width: 50, align: 'center' })
        .text('Unit Price', 310, itemStartY, { width: 80, align: 'right' })
        .text('Total', 490, itemStartY, { width: 70, align: 'right' });

        doc.moveDown(0.7);

        // Divider under header
        doc.strokeColor('#ddd').lineWidth(0.5);
        doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
        doc.moveDown(0.3);

        // Items
        doc.fontSize(12).font('Helvetica').fillColor('#000');
        (order.items || []).forEach((item) => {
        const lineTotal = (Number(item.price) * item.quantity).toFixed(2);
        const itemY = doc.y;

        doc
            .text(item.productName, 50, itemY, { width: 190 })
            .text(String(item.quantity), 250, itemY, { width: 50, align: 'center' })
            .text(`$${Number(item.price).toFixed(2)}`, 310, itemY, { width: 80, align: 'right' })
            .text(`$${lineTotal}`, 490, itemY, { width: 70, align: 'right' });

        doc.moveDown(0.5);
        });

        // Divider
        doc.strokeColor('#333').lineWidth(1);
        doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
        doc.moveDown(0.4);

        // Total
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e7e34');
        const totalY = doc.y;
        doc
        .text('TOTAL PAID:', 310, totalY, { width: 80, align: 'right' })
        .fontSize(12)
        .text(`$${Number(order.total).toFixed(2)}`, 490, totalY, { width: 70, align: 'right' });

        doc.fillColor('#000').moveDown(1.5);

        // Divider
        doc.strokeColor('#ddd').lineWidth(0.5);
        doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
        doc.moveDown(0.6);

        // Footer
        doc
        .fontSize(12)
        .font('Helvetica-Oblique')
        .fillColor('#1e7e34')
        .text('Thank you for shopping with us!', 50, doc.y, {
            width: doc.page.width - 100,
            align: 'center',
        });

        doc.end();

        stream.on('finish', resolve);
        stream.on('error', reject);
    });
    }

    /**
     * Nodemailer transporter (singleton).
     * Uses Gmail App Password stored in env vars.
     */
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

    async function sendReceiptEmail({ pdfPath, toEmail, orderId }) {
    const transporter = getMailTransporter();

    const mailOptions = {
        from: `"Supermarket Receipts" <${process.env.GMAIL_USER}>`,
        to: toEmail,
        subject: `Your Supermarket Receipt (Order #${orderId})`,
        text: 'Thank you for your order! Attached is your receipt.',
        attachments: [{ filename: `receipt-${orderId}.pdf`, path: pdfPath }],
    };

    return transporter.sendMail(mailOptions);
    }

    function isProbablyEmail(s) {
    return typeof s === 'string' && /^\S+@\S+\.\S+$/.test(s.trim());
    }

    module.exports = {
    showCheckout(req, res) {
        const cart = req.session.cart || [];
        const user = req.session.user;
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

        res.render('checkout', {
        cart,
        user,
        total,
        paypalClientId: process.env.PAYPAL_CLIENT_ID,
        errors: req.flash('error'),
        });
    },

    confirmOrder: async function (req, res) {
        const cart = req.session.cart || [];
        const user = req.session.user;
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

        let paymentMethod = req.body?.paymentMethod || 'Card';
        if (!paymentMethod.trim()) paymentMethod = 'Card';

        let bankScreenshotPath = null;
        if (req.file) bankScreenshotPath = '/uploads/' + req.file.filename;

        if (!cart.length) {
        req.flash('error', 'Cart is empty');
        return res.redirect('/cart');
        }

        const orderDate = formatDateForSQL(new Date());

        db.query(
        'INSERT INTO orders (userId, items, total, paymentMethod, orderDate, status' +
            (bankScreenshotPath ? ', bankScreenshot' : '') +
            ') VALUES (?, ?, ?, ?, ?, ?' +
            (bankScreenshotPath ? ', ?' : '') +
            ')',
        bankScreenshotPath
            ? [user.id, JSON.stringify(cart), total, paymentMethod, orderDate, 'paid', bankScreenshotPath]
            : [user.id, JSON.stringify(cart), total, paymentMethod, orderDate, 'paid'],
        async (err, result) => {
            if (err) {
            req.flash('error', 'Could not save order');
            return res.redirect('/checkout');
            }

            // Inventory adjustment
            const updateStockPromises = cart.map(
            (item) =>
                new Promise((resolve, reject) => {
                db.query(
                    'UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?',
                    [item.quantity, item.productId, item.quantity],
                    (e, r) => {
                    if (e) return reject(e);
                    if (r.affectedRows === 0) return reject(new Error('Insufficient stock for ' + item.productName));
                    resolve(r);
                    }
                );
                })
            );

            try {
            await Promise.all(updateStockPromises);
            } catch (stockErr) {
            req.flash('error', 'Order failed: ' + stockErr.message);
            return res.redirect('/cart');
            }

            const orderId = result.insertId;

            const receiptPath = path.join(__dirname, '..', 'public', 'receipts', `receipt-${orderId}.pdf`);
            const orderObj = {
            id: orderId,
            items: cart,
            total,
            orderDate: new Date().toLocaleString(),
            paymentMethod,
            };

            try {
            await generateReceiptPDF(orderObj, user, receiptPath);
            } catch (pdfErr) {
            req.flash('error', 'Receipt generation failed');
            return res.redirect('/checkout');
            }

            CartController.clearCartAll(req, () => {});
            return res.render('receipt', {
            user,
            cart,
            total,
            orderId,
            receiptDownloadPath: `/receipts/receipt-${orderId}.pdf`,
            emailSent: null,
            emailError: null,
            });
        }
        );
    },

    // PayPal success: reuse confirmOrder but force paymentMethod="PayPal"
    paypalSuccess: async function (req, res) {
        req.body = req.body || {};
        req.body.paymentMethod = 'PayPal';
        return this.confirmOrder(req, res);
    },

    emailReceipt: async function (req, res) {
        const orderId = req.params.orderId;
        const userEmail = (req.body.email || '').trim();

        if (!isProbablyEmail(userEmail)) {
        return res.render('receipt', {
            emailError: 'Please provide a valid email address.',
            emailSent: null,
            user: req.session.user || { username: 'Guest', email: userEmail },
            cart: [],
            total: 0,
            orderId,
            receiptDownloadPath: `/receipts/receipt-${orderId}.pdf`,
        });
        }

        db.query('SELECT * FROM orders WHERE id=?', [orderId], async (err, results) => {
        if (err || !results || results.length === 0) {
            return res.render('receipt', {
            emailError: 'Order not found.',
            emailSent: null,
            user: req.session.user || { username: 'Guest', email: userEmail },
            cart: [],
            total: 0,
            orderId,
            receiptDownloadPath: `/receipts/receipt-${orderId}.pdf`,
            });
        }

        const order = results[0];
        const cart = JSON.parse(order.items || '[]');
        const total = order.total;

        const tempUser = { username: (req.session.user && req.session.user.username) || 'Guest', email: userEmail };

        const receiptPath = path.join(__dirname, '..', 'public', 'receipts', `receipt-${orderId}.pdf`);

        try {
            if (!fs.existsSync(receiptPath)) {
            await generateReceiptPDF(
                {
                id: orderId,
                items: cart,
                total,
                orderDate: order.orderDate,
                paymentMethod: order.paymentMethod,
                },
                tempUser,
                receiptPath
            );
            }

            await sendReceiptEmail({ pdfPath: receiptPath, toEmail: userEmail, orderId });
            return res.render('receipt', {
            user: req.session.user || tempUser,
            cart,
            total,
            orderId,
            receiptDownloadPath: `/receipts/receipt-${orderId}.pdf`,
            emailSent: userEmail,
            emailError: null,
            });
        } catch (e) {
            return res.render('receipt', {
            user: req.session.user || tempUser,
            cart,
            total,
            orderId,
            receiptDownloadPath: `/receipts/receipt-${orderId}.pdf`,
            emailSent: null,
            emailError: e?.message || 'Failed to send email',
            });
        }
        });
    },

    history(req, res) {
        const user = req.session.user;

        db.query(
        'SELECT * FROM orders WHERE userId=? AND status=? ORDER BY orderDate DESC',
        [user.id, 'paid'],
        (err, orders) => {
            if (err) return res.status(500).json({ error: 'Database error', details: err });

            orders.forEach((order) => {
            order.items = JSON.parse(order.items || '[]');
            order.receiptLink = `/receipts/receipt-${order.id}.pdf`;
            });

            res.render('orderHistory', { user, orders });
        }
        );
    },

    // Stripe success - verify payment & generate receipt
    showReceiptSuccess: async function (req, res) {
        const sessionId = req.query.session_id;
        if (!sessionId) return res.redirect('/cart');

        try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== 'paid') return res.redirect('/checkout?canceled=true');

        const user = req.session.user;
        const cart = req.session.cart || [];
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

        const orderDate = formatDateForSQL(new Date());

        db.query(
            'INSERT INTO orders (userId, items, total, paymentMethod, orderDate, status) VALUES (?, ?, ?, ?, ?, ?)',
            [user.id, JSON.stringify(cart), total, 'Stripe Card', orderDate, 'paid'],
            async (err, result) => {
            if (err) {
                console.error(err);
                return res.redirect('/checkout?error=true');
            }

            try {
                const updateStockPromises = cart.map(
                (item) =>
                    new Promise((resolve, reject) => {
                    db.query(
                        'UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?',
                        [item.quantity, item.productId, item.quantity],
                        (e, r) => (e ? reject(e) : resolve(r))
                    );
                    })
                );
                await Promise.all(updateStockPromises);
            } catch (e) {
                console.error(e);
                return res.redirect('/checkout?error=true');
            }

            CartController.clearCartAll(req, () => {});

            const orderId = result.insertId;
            const receiptPath = path.join(__dirname, '..', 'public', 'receipts', `receipt-${orderId}.pdf`);

            try {
                await generateReceiptPDF(
                {
                    id: orderId,
                    items: cart,
                    total,
                    orderDate: new Date().toLocaleString(),
                    paymentMethod: 'Stripe Card',
                },
                user,
                receiptPath
                );
            } catch (e) {
                console.error(e);
                return res.redirect('/checkout?error=true');
            }

            res.render('receipt', {
                user,
                cart,
                total,
                orderId,
                receiptDownloadPath: `/receipts/receipt-${orderId}.pdf`,
                emailSent: null,
                emailError: null,
                stripeSuccess: true,
            });
            }
        );
        } catch (error) {
        console.error('Stripe verification failed:', error);
        res.redirect('/checkout?error=true');
        }
    },
    };
