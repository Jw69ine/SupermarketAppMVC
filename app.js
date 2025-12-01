// app.js
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const path = require('path');
const app = express();

// Controllers and models
const ProductController = require('./controllers/ProductController');
const UserController = require('./controllers/UserController');
const Product = require('./models/Product');
const CheckoutController = require('./controllers/CheckoutController');
const AdminController = require('./controllers/AdminController');
const CartController = require('./controllers/CartController'); // Add this import

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

// Registration validator
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

// Add to cart: use controller, persist to DB as well as session
app.post('/add-to-cart/:id', checkAuthenticated, (req, res) => {
    CartController.add(req, res); 
});

// Update cart item quantities (add route if not present)
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

// Show checkout page with invoice/payment options
app.get('/checkout', checkAuthenticated, CheckoutController.showCheckout);

// Confirm order, process payment, send invoice
app.post('/checkout/confirm', checkAuthenticated, bankUpload.single('bankScreenshot'), CheckoutController.confirmOrder);


// Order history (download links for paid orders only)
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
        user: req.session.user || null, // send user so navbar partial always works
        messages: req.flash('error'),
        formData: req.flash('formData')[0]
    });
});

// Registration POST route should ignore role from the form and always set role='user'
app.post('/register', (req, res) => {
    req.body.role = 'user'; // Always enforce role = user
    UserController.add(req, res);
});


// -------- LOGIN (with cart load on success) --------
app.get('/login', (req, res) => {
    res.render('login', {
        user: req.session.user || null,     // Ensures navbar partial always works
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
            // Load persistent cart from DB after login
            CartController.loadCartToSession(req, () => {
                req.flash('success', 'Login successful!');
                if (req.session.user.role === 'user')
                    res.redirect('/shopping');
                else
                    res.redirect('/inventory');
            });
        } else {
            req.flash('error', 'Invalid email or password.');
            res.redirect('/login');
        }
    });
});
// Serve receipt files statically
app.use('/receipts', express.static(path.join(__dirname, 'public', 'receipts')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
