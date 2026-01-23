    // app.js
    require('dotenv').config();
    const express = require('express');
    const session = require('express-session');
    const flash = require('connect-flash');
    const multer = require('multer');
    const path = require('path');
    const app = express();
    const paypal = require('./services/paypal');
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    // Controllers and models
    const ProductController = require('./controllers/ProductController');
    const UserController = require('./controllers/UserController');
    const Product = require('./models/Product');
    const CheckoutController = require('./controllers/CheckoutController');
    const AdminController = require('./controllers/AdminController');
    const CartController = require('./controllers/CartController');

    // Multer setup for image uploads
    const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, 'public/images'); },
    filename: (req, file, cb) => { cb(null, file.originalname); }
    });
    const upload = multer({ storage: storage });

    const paymentStorage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, 'public/receipts'); },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
    });
    const paymentUpload = multer({ storage: paymentStorage });

    const bankStorage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, 'public/uploads'); },
    filename: (req, file, cb) => { cb(null, Date.now() + '-' + file.originalname); }
    });
    const bankUpload = multer({ storage: bankStorage });

    // View engine and essentials
    app.set('view engine', 'ejs');
    app.use(express.static('public'));
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json()); // IMPORTANT: for PayPal POST JSON bodies

    // Sessions and flash
    app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
    }));
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

    // Registration validator (kept as-is; you may wire it to POST /register if needed)
    const validateRegistration = (req, res, next) => {
    const { username, email, password, address, contact, role } = req.body;
    if (!username || !email || !password || !address || !contact || !role) {
        return res.status(400).send('All fields are required.');
    }
    if (password.length < 6) {
        req.flash('error', 'Password should be at least 6 or more characters long');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }
    next();
    };

    // -------- ROUTES --------

    // Home
    app.get('/', (req, res) => {
    res.render('index', { user: req.session.user });
    });

    // Admin dashboard
    app.get('/admin/dashboard', checkAuthenticated, checkAdmin, AdminController.dashboard);

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

    // Add to cart
    app.post('/add-to-cart/:id', checkAuthenticated, (req, res) => {
    CartController.add(req, res);
    });

    // Update cart
    app.post('/update-cart/:id', checkAuthenticated, (req, res) => {
    CartController.update(req, res);
    });

    // Delete cart item
    app.post('/cart/remove/:id', checkAuthenticated, (req, res) => {
    CartController.delete(req, res);
    });

    app.post('/cart/clear', checkAuthenticated, (req, res) => {
    CartController.clearCartAll(req, () => {
        req.flash('messages', ['Cart cleared!']);
        res.redirect('/cart');
    });
    });

    // Show cart
    app.get('/cart', checkAuthenticated, (req, res) => {
    CartController.list(req, res);
    });

    // -------- CHECKOUT/INVOICE FLOW --------

    // Show checkout page
    app.get('/checkout', checkAuthenticated, CheckoutController.showCheckout);

    // Stripe: Create Checkout Session
    app.post('/checkout/create-stripe-session', checkAuthenticated, async (req, res) => {
    try {
        const cart = req.session.cart || [];

        const sessionObj = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: cart.map(item => ({
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
        metadata: { userId: req.session.user.id.toString() }
        });

        res.json({ url: sessionObj.url });
    } catch (error) {
        console.error('Stripe error:', error);
        res.status(500).json({ error: 'Payment setup failed' });
    }
    });

    // Stripe Success
    app.get('/checkout/success', checkAuthenticated, CheckoutController.showReceiptSuccess);

    // Confirm order (BankTransfer / your existing flow)
    app.post('/checkout/confirm', checkAuthenticated, bankUpload.single('bankScreenshot'), CheckoutController.confirmOrder);

    // -------------------- PAYPAL --------------------

    // PayPal: Create Order (server calculates total from session cart)
    app.post('/api/paypal/create-order', checkAuthenticated, async (req, res) => {
    try {
        const cart = req.session.cart || [];
        if (!cart.length) {
        return res.status(400).json({ error: 'Cart is empty' });
        }

        const total = cart
        .reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);

        if (!Number.isFinite(total) || total <= 0) {
        return res.status(400).json({ error: 'Cart total invalid' });
        }

        const order = await paypal.createOrder(total.toFixed(2), 'SGD');

        return res.json({ id: order.id });
    } catch (err) {
        console.error('Create PayPal order exception:', err);
        return res.status(500).json({
        error: 'Failed to create PayPal order',
        message: err.message,
        });
    }
    });

    // PayPal: Capture Order (CAPTURE ONCE, then redirect to success page)
    app.post('/api/paypal/capture-order', checkAuthenticated, async (req, res) => {
    try {
        const { orderID } = req.body;
        if (!orderID) {
        return res.status(400).json({ error: 'Missing orderID' });
        }

        const capture = await paypal.captureOrder(orderID);

        if (capture.status === 'COMPLETED') {
        req.session.lastPaypalCapturedOrderID = orderID;
        return res.json({
            redirectUrl: `/paypal/success?orderID=${encodeURIComponent(orderID)}`,
        });
        }

        return res.status(400).json({ error: 'Payment not completed', details: capture });
    } catch (err) {
        console.error('Capture PayPal order exception:', err);
        return res.status(500).json({
        error: 'Failed to capture PayPal order',
        message: err.message,
        });
    }
    });

    // PayPal success page (DO NOT capture again here)
    app.get('/paypal/success', checkAuthenticated, async (req, res) => {
    try {
        const { orderID } = req.query;
        if (!orderID) return res.redirect('/checkout?error=paypal');

        if (
        !req.session.lastPaypalCapturedOrderID ||
        req.session.lastPaypalCapturedOrderID !== orderID
        ) {
        return res.redirect('/checkout?error=paypal');
        }

        delete req.session.lastPaypalCapturedOrderID;

        req.body = { paymentMethod: 'PayPal' };
        return CheckoutController.paypalSuccess(req, res);
    } catch (err) {
        console.error('paypal/success exception:', err);
        return res.redirect('/checkout?error=paypal');
    }
    });

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
        formData: req.flash('formData')[0]
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
        errors: req.flash('error')
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
