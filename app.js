    // app.js
    require('dotenv').config();
    const express = require('express');
    const session = require('express-session');
    const flash = require('connect-flash');
    const multer = require('multer');
    const path = require('path');
    const crypto = require('crypto');

    const app = express();

    const paypal = require('./services/paypal');
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    // Controllers
    const ProductController = require('./controllers/ProductController');
    const UserController = require('./controllers/UserController');
    const CheckoutController = require('./controllers/CheckoutController');
    const AdminController = require('./controllers/AdminController');
    const CartController = require('./controllers/CartController');
    const RefundController = require('./controllers/RefundController');

    // Multer setup for image uploads
    const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/images'),
    filename: (req, file, cb) => cb(null, file.originalname),
    });
    const upload = multer({ storage });

    // Bank transfer upload (screenshot)
    const bankStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
    });
    const bankUpload = multer({ storage: bankStorage });

    // View engine and essentials
    app.set('view engine', 'ejs');
    app.use(express.static('public'));

    // IMPORTANT for webhook signature verification:
    // we need raw body for /webhooks/hitpay, so we add a raw middleware only for that route. [page:1]
    app.use('/webhooks/hitpay', express.raw({ type: '*/*' }));

    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());

    // Sessions and flash
    app.use(
    session({
        secret: 'secret',
        resave: false,
        saveUninitialized: true,
        cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
    })
    );
    app.use(flash());

    // Auth middlewares
    const checkAuthenticated = (req, res, next) => {
    if (req.session.user) return next();
    req.flash('error', 'Please log in to view this resource');
    res.redirect('/login');
    };

    const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') return next();
    req.flash('error', 'Access denied');
    res.redirect('/shopping');
    };

    // -------------------- HITPAY helpers --------------------
    function getHitpayBaseUrl() {
    return process.env.HITPAY_BASE_URL || 'https://api.sandbox.hit-pay.com';
    }

    function requireHitpayEnv() {
    if (!process.env.HITPAY_API_KEY) throw new Error('Missing HITPAY_API_KEY in .env');
    if (!process.env.HITPAY_SALT) throw new Error('Missing HITPAY_SALT in .env');
    if (!process.env.HITPAY_REDIRECT_URL) throw new Error('Missing HITPAY_REDIRECT_URL in .env');

    // Optional (because docs say registered webhooks are preferred), but your create-payment uses it:
    if (!process.env.HITPAY_WEBHOOK_URL) throw new Error('Missing HITPAY_WEBHOOK_URL in .env');
    }

    // Verify webhook signature using salt (HMAC-SHA256 of raw JSON payload). [page:1]
    function verifyHitpaySignature(rawBodyBuf, signatureHeader, salt) {
    if (!signatureHeader || typeof signatureHeader !== 'string') return false;
    const computed = crypto.createHmac('sha256', salt).update(rawBodyBuf).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signatureHeader));
    } catch {
        return false;
    }
    }

    // -------------------- ROUTES --------------------

    // Home
    app.get('/', (req, res) => {
    res.render('index', { user: req.session.user });
    });

    // Admin dashboard
    app.get('/admin/dashboard', checkAuthenticated, checkAdmin, AdminController.dashboard);

    // -------------------- Refund routes --------------------
    app.get('/customer-service', checkAuthenticated, RefundController.customerService);
    app.post('/refund/request', checkAuthenticated, RefundController.createRequest);

    app.get('/admin/refunds', checkAuthenticated, checkAdmin, AdminController.refundList);
    app.post('/admin/refunds/:id/approve', checkAuthenticated, checkAdmin, AdminController.approveRefund);
    app.post('/admin/refunds/:id/reject', checkAuthenticated, checkAdmin, AdminController.rejectRefund);
    // -------------------- END Refund routes --------------------

    // Product inventory routes
    app.get('/inventory', checkAuthenticated, checkAdmin, ProductController.list);
    app.get('/shopping', checkAuthenticated, ProductController.list);
    app.get('/product/:id', checkAuthenticated, ProductController.getById);

    // Add product (admin only, image upload)
    app.get('/addProduct', checkAuthenticated, checkAdmin, (req, res) => {
    res.render('addProduct', { user: req.session.user });
    });
    app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), ProductController.add);

    // Update product (admin only)
    app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, ProductController.getById);
    app.post('/updateProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), ProductController.update);

    // Delete product
    app.get('/deleteProduct/:id', checkAuthenticated, checkAdmin, ProductController.delete);

    // -------- CART ROUTES (PERSISTENT) --------
    app.post('/add-to-cart/:id', checkAuthenticated, (req, res) => CartController.add(req, res));
    app.post('/update-cart/:id', checkAuthenticated, (req, res) => CartController.update(req, res));
    app.post('/cart/remove/:id', checkAuthenticated, (req, res) => CartController.delete(req, res));

    app.post('/cart/clear', checkAuthenticated, (req, res) => {
    CartController.clearCartAll(req, () => {
        req.flash('messages', ['Cart cleared!']);
        res.redirect('/cart');
    });
    });

    app.get('/cart', checkAuthenticated, (req, res) => CartController.list(req, res));

    // -------- CHECKOUT/INVOICE FLOW --------
    app.get('/checkout', checkAuthenticated, CheckoutController.showCheckout);

    // Stripe: Create Checkout Session
    app.post('/checkout/create-stripe-session', checkAuthenticated, async (req, res) => {
    try {
        const cart = req.session.cart || [];
        const sessionObj = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: cart.map((item) => ({
            price_data: {
            currency: 'usd', // change to 'sgd' if needed
            product_data: { name: item.productName },
            unit_amount: Math.round(item.price * 100),
            },
            quantity: item.quantity,
        })),
        mode: 'payment',
        success_url: `${req.headers.origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${req.headers.origin}/checkout?canceled=true`,
        metadata: { userId: req.session.user.id.toString() },
        });

        res.json({ url: sessionObj.url });
    } catch (error) {
        console.error('Stripe error:', error);
        res.status(500).json({ error: 'Payment setup failed' });
    }
    });

    // Stripe Success
    app.get('/checkout/success', checkAuthenticated, CheckoutController.showReceiptSuccess);

    // Confirm order (BankTransfer / existing flow)
    app.post('/checkout/confirm', checkAuthenticated, bankUpload.single('bankScreenshot'), CheckoutController.confirmOrder);

    // -------------------- PAYPAL --------------------

    // PayPal: Create Order
    app.post('/api/paypal/create-order', checkAuthenticated, async (req, res) => {
    try {
        const cart = req.session.cart || [];
        if (!cart.length) return res.status(400).json({ error: 'Cart is empty' });

        const total = cart.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);
        if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ error: 'Cart total invalid' });

        const order = await paypal.createOrder(total, 'SGD');
        return res.json({ id: order.id });
    } catch (err) {
        console.error('Create PayPal order exception:', err);
        return res.status(500).json({ error: 'Failed to create PayPal order', message: err.message });
    }
    });

    // PayPal: Capture Order
    app.post('/api/paypal/capture-order', checkAuthenticated, async (req, res) => {
    try {
        const orderID = req.body?.orderID || req.body?.orderId;
        if (!orderID) return res.status(400).json({ error: 'Missing orderID' });

        const capture = await paypal.captureOrder(orderID);
        const captureId = capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;

        if (capture?.status === 'COMPLETED') {
        req.session.lastPaypalCapturedOrderID = orderID;
        req.session.lastPaypalCaptureId = captureId;

        return res.json({
            ok: true,
            redirectUrl: `/paypal/success?orderID=${encodeURIComponent(orderID)}`,
        });
        }

        return res.status(400).json({ error: 'Payment not completed', details: capture });
    } catch (err) {
        console.error('Capture PayPal order exception:', err);
        return res.status(500).json({ error: 'Failed to capture PayPal order', message: err.message });
    }
    });

    // PayPal success page (DO NOT capture again here)
    app.get('/paypal/success', checkAuthenticated, async (req, res) => {
    try {
        const { orderID } = req.query;
        if (!orderID) return res.redirect('/checkout?error=paypal');

        if (!req.session.lastPaypalCapturedOrderID || req.session.lastPaypalCapturedOrderID !== orderID) {
        return res.redirect('/checkout?error=paypal');
        }

        req.body = { paymentMethod: 'PayPal' };
        return CheckoutController.paypalSuccess(req, res);
    } catch (err) {
        console.error('paypal/success exception:', err);
        return res.redirect('/checkout?error=paypal');
    }
    });

    // -------------------- HITPAY (PayNow) --------------------
    // Create HitPay payment request and redirect customer to returned "url". [page:1]
    app.post('/api/hitpay/create-payment', checkAuthenticated, async (req, res) => {
    try {
        requireHitpayEnv();

        const cart = req.session.cart || [];
        if (!cart.length) return res.status(400).json({ error: 'Cart is empty' });

        const total = cart.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);
        if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ error: 'Cart total invalid' });

        const amount = Number(total.toFixed(2));
        const currency = 'SGD';

        const purpose = `Supermarket Order - ${req.session.user.username}`;
        const reference_number = `HP-${req.session.user.id}-${Date.now()}`;

        // Note: docs show payment_methods[] and Content-Type x-www-form-urlencoded; JSON also works for many setups,
        // but if you get issues, switch to URLSearchParams. [page:1]
        const payload = {
        amount,
        currency,
        purpose,
        reference_number,
        redirect_url: process.env.HITPAY_REDIRECT_URL,
        webhook: process.env.HITPAY_WEBHOOK_URL, // deprecated, but still supported in doc; prefer registered webhooks. [page:1]
        payment_methods: ['paynow_online'],
        };

        const resp = await fetch(`${getHitpayBaseUrl()}/v1/payment-requests`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-BUSINESS-API-KEY': process.env.HITPAY_API_KEY,
        },
        body: JSON.stringify(payload),
        });

        const data = await resp.json().catch(() => ({}));

        if (!resp.ok) {
        console.error('HitPay create payment failed:', data);
        return res.status(400).json({ error: data?.message || 'HitPay create payment failed', details: data });
        }

        if (!data.url) return res.status(500).json({ error: 'HitPay did not return checkout url', details: data });

        return res.json({
        ok: true,
        url: data.url,
        reference_number,
        payment_request_id: data.id || data.payment_request_id,
        });
    } catch (e) {
        console.error('HitPay create-payment error:', e);
        return res.status(500).json({ error: e.message || 'HitPay create payment error' });
    }
    });

    // Return URL (HitPay sends query arguments reference (payment request id) and status). [page:1]
    app.get('/hitpay/return', checkAuthenticated, async (req, res) => {
    const reference = req.query.reference; // payment_request_id [page:1]
    const status = String(req.query.status || '').toLowerCase(); // "completed"/... [page:1]

    if (!reference) return res.redirect('/checkout?error=hitpay');

    // Verify using payment request status endpoint (recommended) [page:1]
    let paid = status === 'completed';

    try {
        requireHitpayEnv();
        const resp = await fetch(`${getHitpayBaseUrl()}/v1/payment-requests/${encodeURIComponent(reference)}`, {
        method: 'GET',
        headers: { 'X-BUSINESS-API-KEY': process.env.HITPAY_API_KEY },
        });
        const data = await resp.json().catch(() => ({}));
        const apiStatus = String(data.status || '').toLowerCase();
        if (apiStatus) paid = apiStatus === 'completed';
    } catch (e) {
        console.error('HitPay verify status failed:', e);
    }

    if (!paid) return res.redirect('/checkout?status=' + encodeURIComponent(status || 'unknown'));

    // Set session for CheckoutController to insert payment row
    req.session.lastProvider = 'HITPAY';
    req.session.lastProviderOrderId = reference;
    req.session.lastProviderPaymentId = reference;
    req.session.lastProviderCurrency = 'SGD';
    req.session.lastHitpayPaymentRequestId = reference;

    req.body = { paymentMethod: 'PayNow (HitPay)' };
    return CheckoutController.confirmOrder(req, res);
    });

    // Webhook (payment completed) - validates Hitpay-Signature and contains status=completed. [page:1]
    app.post('/webhooks/hitpay', async (req, res) => {
    try {
        requireHitpayEnv();

        const signature = req.header('Hitpay-Signature');
        const rawBody = req.body; // Buffer (because we used express.raw above)

        if (!verifyHitpaySignature(rawBody, signature, process.env.HITPAY_SALT)) {
        return res.status(401).send('Invalid signature');
        }

        const event = JSON.parse(rawBody.toString('utf8'));

        // For production: mark order paid ONLY after webhook is validated. [page:1]
        return res.status(200).send('OK');
    } catch (e) {
        console.error('HitPay webhook error:', e);
        return res.status(500).send('Server error');
    }
    });
    // -------------------- END HITPAY --------------------

    // Order history
    app.get('/orders', checkAuthenticated, CheckoutController.history);

    // Serve invoice and receipt files statically
    app.use('/receipts', express.static(path.join(__dirname, 'public', 'receipts')));
    app.use('/invoices', express.static(path.join(__dirname, 'public', 'invoices')));
    app.post('/email-receipt/:orderId', CheckoutController.emailReceipt);

    // Logout
    app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
    });

    // Admin: View a user's profile
    app.get('/users/:id', checkAuthenticated, checkAdmin, UserController.showProfile);

    // Registration and login
    app.get('/register', (req, res) => {
    res.render('register', {
        user: req.session.user || null,
        messages: req.flash('error'),
        formData: req.flash('formData')[0],
    });
    });

    app.post('/register', (req, res) => {
    req.body.role = 'user';
    UserController.add(req, res);
    });

    // -------- LOGIN (with cart load on success) --------
    app.get('/login', (req, res) => {
    res.render('login', {
        user: req.session.user || null,
        messages: req.flash('success'),
        errors: req.flash('error'),
    });
    });

    app.post('/login', (req, res) => {
    const db = require('./db');
    const { email, password } = req.body;

    if (!email || !password) {
        req.flash('error', 'All fields are required.');
        return res.redirect('/login');
    }

    const sql = 'SELECT * FROM users WHERE email = ? AND password = SHA1(?)';
    db.query(sql, [email, password], (err, results) => {
        if (err) throw err;

        if (results.length > 0) {
        req.session.user = results[0];

        CartController.loadCartToSession(req, () => {
            req.flash('success', 'Login successful!');
            if (req.session.user.role === 'user') return res.redirect('/shopping');
            return res.redirect('/inventory');
        });
        } else {
        req.flash('error', 'Invalid email or password.');
        res.redirect('/login');
        }
    });
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    module.exports = app;