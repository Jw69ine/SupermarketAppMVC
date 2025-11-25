const db = require('../db');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const CartController = require('./CartController');
const nodemailer = require('nodemailer');

// Helper: format JS Date -> MySQL DATETIME 'YYYY-MM-DD HH:mm:ss'
function formatDateForSQL(dateObj) {
    const pad = n => n < 10 ? '0' + n : n;
    return dateObj.getFullYear() + '-' +
        pad(dateObj.getMonth() + 1) + '-' +
        pad(dateObj.getDate()) + ' ' +
        pad(dateObj.getHours()) + ':' +
        pad(dateObj.getMinutes()) + ':' +
        pad(dateObj.getSeconds());
}

// Helper: Generate PDF Receipt
function generateReceiptPDF(order, user, filepath) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const stream = fs.createWriteStream(filepath);
        doc.pipe(stream);
        // PDF rendering code unchanged...
        doc.fontSize(26).font('Helvetica-Bold').text('SUPERMARKET', { align: 'left' })
            .moveDown(0.5).fontSize(18).font('Helvetica').fillColor('#555')
            .text('Official Receipt', { align: 'left' }).fillColor('#000').moveDown();
        doc.fontSize(12);
        doc.text(`Receipt #: `, { continued: true }).font('Helvetica-Bold').text(order.id).font('Helvetica');
        doc.text(`Date: `, { continued: true }).font('Helvetica-Bold').text(order.orderDate).font('Helvetica');
        doc.text(`Customer: `, { continued: true }).font('Helvetica-Bold').text(user.username + ' (' + user.email + ')').font('Helvetica');
        doc.text(`Payment Method: `, { continued: true }).font('Helvetica-Bold').text(order.paymentMethod).moveDown();
        doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
        doc.moveDown();
        doc.fontSize(14)
            .font('Helvetica-Bold')
            .text('Item', 60, doc.y, { continued: true })
            .text('Qty', 260, doc.y, { width: 60, align: 'right', continued: true })
            .text('Unit Price', 330, doc.y, { width: 100, align: 'right', continued: true })
            .text('Line Total', 450, doc.y, { width: 90, align: 'right' })
            .moveDown(0.5);
        doc.font('Helvetica').fontSize(12);
        order.items.forEach(item => {
            doc
                .text(item.productName, 60, doc.y, { continued: true })
                .text(item.quantity, 260, doc.y, { width: 60, align: 'right', continued: true })
                .text(`$${Number(item.price).toFixed(2)}`, 330, doc.y, { width: 100, align: 'right', continued: true })
                .text(`$${(item.price * item.quantity).toFixed(2)}`, 450, doc.y, { width: 90, align: 'right' });
        });
        doc.moveDown(0.5);
        doc.moveTo(60, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
        doc.fontSize(14).font('Helvetica-Bold')
            .text('Total Paid:', 340, doc.y + 5, { width: 100, align: 'right', continued: true })
            .fillColor('#1e7e34')
            .text(`$${Number(order.total).toFixed(2)}`, 450, doc.y + 5, { width: 90, align: 'right' })
            .fillColor('#000');
        doc.moveDown(2);
        doc.fontSize(12).font('Helvetica-Oblique').fillColor('#1e7e34')
            .text('Thank you for shopping with us!', { align: 'center' });
        doc.end();
        stream.on('finish', resolve);
        stream.on('error', reject);
    });
}

// Helper: Email PDF. Pass in recipient email; cb gets (emailError, emailSent).
function emailReceiptPDF(pdfPath, toEmail, orderId, cb) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: 'WebAppTesting67@gmail.com',
            pass: 'aodcvynoiosnovbq' // app password
        }
    });
    const mailOptions = {
        from: '"Supermarket Receipts" <WebAppTesting67@gmail.com>',
        to: toEmail,
        subject: `Your Supermarket Receipt (Order #${orderId})`,
        text: `Thank you for your order! Attached is your receipt.`,
        attachments: [
            { filename: `receipt-${orderId}.pdf`, path: pdfPath }
        ]
    };
    transporter.sendMail(mailOptions, (err, info) => {
        if ((!err && info && info.accepted && info.accepted.length > 0) || (info && info.response && info.response.includes("OK"))) {
            cb(null, toEmail); // success
        } else {
            cb(err ? (err.message || "Error sending email") : "Unknown error", null);
        }
    });
}

module.exports = {
    showCheckout(req, res) {
        const cart = req.session.cart || [];
        const user = req.session.user;
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        res.render('checkout', { cart, user, total, errors: req.flash('error') });
    },

    confirmOrder: async function(req, res) {
        const cart = req.session.cart || [];
        const user = req.session.user;
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

        let paymentMethod = (req.body && req.body.paymentMethod) ? req.body.paymentMethod : 'Card';
        if (!paymentMethod || !paymentMethod.trim()) paymentMethod = 'Card';

        let bankScreenshotPath = null;
        if (req.file) {
            bankScreenshotPath = '/uploads/' + req.file.filename;
        }

        if (!cart.length) {
            req.flash('error', 'Cart is empty');
            return res.redirect('/cart');
        }

        const orderDate = formatDateForSQL(new Date());

        db.query(
            'INSERT INTO orders (userId, items, total, paymentMethod, orderDate, status' + (bankScreenshotPath ? ', bankScreenshot' : '') + ') VALUES (?, ?, ?, ?, ?, ?' + (bankScreenshotPath ? ', ?' : '') + ')',
            bankScreenshotPath 
                ? [user.id, JSON.stringify(cart), total, paymentMethod, orderDate, 'paid', bankScreenshotPath] 
                : [user.id, JSON.stringify(cart), total, paymentMethod, orderDate, 'paid'],
            async (err, result) => {
                if (err) {
                    req.flash('error', 'Could not save order');
                    return res.redirect('/checkout');
                }
                // --- 1. Inventory Adjustment ---
                // For each product in the cart: decrement quantity in the DB
                const updateStockPromises = cart.map(item => {
                    return new Promise((resolve, reject) => {
                        db.query(
                            'UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?',
                            [item.quantity, item.productId, item.quantity], // use your product PK (id)
                            (err, result) => {
                                if (err) reject(err);
                                else if (result.affectedRows === 0) reject(new Error('Insufficient stock for ' + item.productName));
                                else resolve(result);
                            }
                        );
                    });
                });
                try {
                    await Promise.all(updateStockPromises);
                } catch (stockErr) {
                    req.flash('error', 'Order failed: ' + stockErr.message);
                    return res.redirect('/cart');
                }
                // --- End inventory adjustment ---

                const orderId = result.insertId;
                const orderObj = {
                    id: orderId,
                    items: cart,
                    total,
                    orderDate: new Date().toLocaleString(),
                    paymentMethod
                };

                const receiptPath = path.join(__dirname, '..', 'public', 'receipts', `receipt-${orderId}.pdf`);
                const receiptsDir = path.join(__dirname, '..', 'public', 'receipts');
                if (!fs.existsSync(receiptsDir)) {
                    fs.mkdirSync(receiptsDir, { recursive: true });
                }
                await generateReceiptPDF(orderObj, user, receiptPath);

                CartController.clearCartAll(req, () => {});
                res.render('receipt', {
                    user,
                    cart,
                    total,
                    orderId,
                    receiptDownloadPath: `/receipts/receipt-${orderId}.pdf`
                });
            }
        );
    },

    // Email receipt to user-supplied address (POST from receipt page/email form)
    emailReceipt: async function(req, res) {
        const orderId = req.params.orderId;
        const userEmail = req.body.email && req.body.email.trim();
        if (!userEmail) {
            return res.render('receipt', {
                emailError: "Please provide an email address.",
                cart: [],
                total: 0,
                orderId,
                receiptDownloadPath: `/receipts/receipt-${orderId}.pdf`
            });
        }
        db.query('SELECT * FROM orders WHERE id=?', [orderId], async (err, results) => {
            if (err || results.length === 0) {
                return res.render('receipt', { emailError: "Order not found.", cart: [], total: 0, orderId });
            }
            const order = results[0];
            const cart = JSON.parse(order.items);
            const total = order.total;
            const tempUser = { username: "Guest", email: userEmail };
            const receiptPath = path.join(__dirname, '..', 'public', 'receipts', `receipt-${orderId}.pdf`);
            if (!fs.existsSync(receiptPath)) {
                await generateReceiptPDF(
                    {
                        id: orderId,
                        items: cart,
                        total,
                        orderDate: order.orderDate,
                        paymentMethod: order.paymentMethod
                    },
                    tempUser,
                    receiptPath
                );
            }
            emailReceiptPDF(receiptPath, userEmail, orderId, (emailError, emailSent) => {
                res.render('receipt', {
                    user: req.session.user || tempUser,
                    cart,
                    total,
                    orderId,
                    receiptDownloadPath: `/receipts/receipt-${orderId}.pdf`,
                    emailSent,
                    emailError
                });
            });
        });
    },

    history(req, res) {
        const user = req.session.user;
        db.query(
            'SELECT * FROM orders WHERE userId=? AND status=? ORDER BY orderDate DESC',
            [user.id, 'paid'],
            (err, orders) => {
                if (err) return res.status(500).json({ error: 'Database error', details: err });
                orders.forEach(order => {
                    order.items = JSON.parse(order.items || '[]');
                    order.receiptLink = `/receipts/receipt-${order.id}.pdf`;
                });
                res.render('orderHistory', { user, orders });
            }
        );
    }
};
