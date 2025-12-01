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


function generateReceiptPDF(order, user, filepath) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const stream = fs.createWriteStream(filepath);
        doc.pipe(stream);

        // Header - centered
        doc.fontSize(26).font('Helvetica-Bold').text('SUPERMARKET', { align: 'center' });
        doc.moveDown(0.2);

        // Date below title
        doc.fontSize(12).font('Helvetica').fillColor('#666')
            .text(`Date: ${order.orderDate}`, { align: 'center' })
            .fillColor('#000')
            .moveDown(0.2);

        // Official Receipt subtitle
        doc.fontSize(12).font('Helvetica').fillColor('#666')
            .text('Official Receipt', { align: 'center' })
            .fillColor('#000')
            .moveDown(0.6);

        // Divider
        doc.strokeColor('#333').lineWidth(1);
        doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
        doc.moveDown(0.4);

        // Receipt details - all on left
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
        doc.text('Item', 50, itemStartY, { width: 200 })
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
        order.items.forEach(item => {
            const lineTotal = (Number(item.price) * item.quantity).toFixed(2);
            const itemY = doc.y;
            
            doc.text(item.productName, 50, itemY, { width: 190 })
                .text(item.quantity.toString(), 250, itemY, { width: 50, align: 'center' })
                .text(`$${Number(item.price).toFixed(2)}`, 310, itemY, { width: 80, align: 'right' })
                .text(`$${lineTotal}`, 490, itemY, { width: 70, align: 'right' });

            doc.moveDown(0.5);
        });

        // Divider
        doc.strokeColor('#333').lineWidth(1);
        doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
        doc.moveDown(0.4);

        // Total - right aligned
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e7e34');
        const totalY = doc.y;
        doc.text('TOTAL PAID:', 310, totalY, { width: 80, align: 'right' })
            .fontSize(12)
            .text(`$${Number(order.total).toFixed(2)}`, 490, totalY, { width: 70, align: 'right' });

        doc.fillColor('#000').moveDown(1.5);

        // Divider
        doc.strokeColor('#ddd').lineWidth(0.5);
        doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
        doc.moveDown(0.6);

        // Thank you - single line, centered
        doc.fontSize(12).font('Helvetica-Oblique').fillColor('#1e7e34')
            .text('Thank you for shopping with us!', 50, doc.y, { width: doc.page.width - 100, align: 'center' });

        doc.end();
        stream.on('finish', resolve);
        stream.on('error', reject);
    });
}

// Helper: Email PDF
function emailReceiptPDF(pdfPath, toEmail, orderId, cb) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: 'WebAppTesting67@gmail.com',
            pass: 'aodcvynoiosnovbq'
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
            cb(null, toEmail);
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

                // Inventory Adjustment
                const updateStockPromises = cart.map(item => {
                    return new Promise((resolve, reject) => {
                        db.query(
                            'UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?',
                            [item.quantity, item.productId, item.quantity],
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
