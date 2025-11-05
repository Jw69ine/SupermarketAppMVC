const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const app = express();

const ProductController = require('./controllers/ProductController');
const UserController = require('./controllers/UserController');
const Product = require('./models/Product'); // used for cart operations that need product details

// Set up multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/images'); // Directory to save uploaded files
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage: storage });

// Remove direct MySQL connection from app.js (handled by models/db.js)

// Set up view engine
app.set('view engine', 'ejs');
//  enable static files
app.use(express.static('public'));
// enable form processing
app.use(express.urlencoded({
    extended: false
}));

// Session middleware
app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    // Session expires after 1 week of inactivity
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

app.use(flash());

// Middleware to check if user is logged in
const checkAuthenticated = (req, res, next) => {
    if (req.session.user) {
        return next();
    } else {
        req.flash('error', 'Please log in to view this resource');
        res.redirect('/login');
    }
};

// Middleware to check if user is admin
const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    } else {
        req.flash('error', 'Access denied');
        res.redirect('/shopping');
    }
};

// Middleware for form validation
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

// Define routes

app.get('/', (req, res) => {
    res.render('index', { user: req.session.user });
});

// Product routes delegated to ProductController (controller methods handle rendering/redirecting)
app.get('/inventory', checkAuthenticated, checkAdmin, ProductController.list);
app.get('/shopping', checkAuthenticated, ProductController.list);
app.get('/product/:id', checkAuthenticated, ProductController.getById);

// Add product - GET renders form, POST delegated to controller (with multer)
app.get('/addProduct', checkAuthenticated, checkAdmin, (req, res) => {
    res.render('addProduct', { user: req.session.user });
});
app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), ProductController.add);

// Update product - GET to render product for edit, POST to perform update (with multer)
app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, ProductController.getById);
app.post('/updateProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), ProductController.update);

// Delete product (keeps same path; controller handles redirect)
app.get('/deleteProduct/:id', checkAuthenticated, checkAdmin, ProductController.delete);

// Cart routes — use model to fetch product details (no raw SQL in route handlers)
app.post('/add-to-cart/:id', checkAuthenticated, (req, res) => {
    const productId = req.params.id;
    const quantity = parseInt(req.body.quantity) || 1;

    Product.getById(productId, (err, product) => {
        if (err) return res.status(500).send('Database error');
        if (!product) return res.status(404).send('Product not found');

        // Initialize cart in session if not exists
        if (!req.session.cart) {
            req.session.cart = [];
        }

        // Check if product already in cart
        const existingItem = req.session.cart.find(item => item.productId === parseInt(productId));
        if (existingItem) {
            existingItem.quantity += quantity;
        } else {
            req.session.cart.push({
                productId: parseInt(productId),
                productName: product.productName,
                price: product.price,
                quantity: quantity,
                image: product.image
            });
        }

        res.redirect('/cart');
    });
});

app.get('/cart', checkAuthenticated, (req, res) => {
    const cart = req.session.cart || [];
    res.render('cart', { cart, user: req.session.user });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// User registration and login
app.get('/register', (req, res) => {
    res.render('register', { messages: req.flash('error'), formData: req.flash('formData')[0] });
});

// Delegate registration to UserController.add (controller should handle redirect/render)
app.post('/register', validateRegistration, (req, res) => {
    // reuse controller method signature (req, res)
    UserController.add(req, res);
});

app.get('/login', (req, res) => {
    res.render('login', { messages: req.flash('success'), errors: req.flash('error') });
});

// Keep login logic here (authentication is application-specific and not covered by basic CRUD controller)
app.post('/login', (req, res) => {
    const db = require('./db'); // use central db connection used by models
    const { email, password } = req.body;

    // Validate email and password
    if (!email || !password) {
        req.flash('error', 'All fields are required.');
        return res.redirect('/login');
    }

    const sql = 'SELECT * FROM users WHERE email = ? AND password = SHA1(?)';
    db.query(sql, [email, password], (err, results) => {
        if (err) {
            throw err;
        }

        if (results.length > 0) {
            // Successful login
            req.session.user = results[0];
            req.flash('success', 'Login successful!');
            if (req.session.user.role == 'user')
                res.redirect('/shopping');
            else
                res.redirect('/inventory');
        } else {
            // Invalid credentials
            req.flash('error', 'Invalid email or password.');
            res.redirect('/login');
        }
    });
});

// port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
