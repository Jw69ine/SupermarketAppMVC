    // controllers/CartController.js
    const db = require('../db');
    const Product = require('../models/Product');

    /** --- DB HELPERS --- **/
    function saveCartToDB(userId, cart, cb) {
    db.query(
        'INSERT INTO carts (userId, items) VALUES (?, ?) ON DUPLICATE KEY UPDATE items=?',
        [userId, JSON.stringify(cart), JSON.stringify(cart)],
        cb
    );
    }

    function getCartFromDB(userId, cb) {
    db.query('SELECT items FROM carts WHERE userId=?', [userId], (err, results) => {
        if (err) return cb(err, []);
        if (results.length) {
        try {
            cb(null, JSON.parse(results[0].items));
        } catch (e) {
            cb(e, []);
        }
        } else {
        cb(null, []);
        }
    });
    }

    function clearCartDB(userId, cb) {
    db.query('DELETE FROM carts WHERE userId=?', [userId], cb);
    }

    /** --- CART CONTROLLER MAIN --- **/
    const CartController = {
    // List all available products
    listProducts(req, res) {
        Product.getAll((err, products) => {
        if (err) return res.status(500).json({ error: 'Database error', details: err });
        res.render('shopping', { products, user: req.session.user });
        });
    },

    // Show one product
    getProductById(req, res) {
        const id = req.params.id;
        Product.getById(id, (err, product) => {
        if (err) return res.status(500).json({ error: 'Database error', details: err });
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.render('product', { product, user: req.session.user });
        });
    },

    // Add product to cart (session and DB) with stock check
    add(req, res) {
        const productId = req.params.id;
        const quantityToAdd = parseInt(req.body.quantity, 10) || 1;

        Product.getById(productId, (err, product) => {
        if (err) return res.status(500).json({ error: 'Database error', details: err });
        if (!product) return res.status(404).json({ error: 'Product not found' });

        if (!req.session.cart) req.session.cart = [];

        const pid = parseInt(productId, 10);
        const existing = req.session.cart.find(item => item.productId === pid);

        const currentQtyInCart = existing ? existing.quantity : 0;
        const newTotalQty = currentQtyInCart + quantityToAdd;

        // Stock check
        if (newTotalQty > product.quantity) {
            req.flash('messages', [
            `Not enough stock. Available: ${product.quantity}, in cart: ${currentQtyInCart}.`,
            ]);
            return res.redirect('/shopping');
        }

        if (existing) {
            existing.quantity = newTotalQty;
        } else {
            req.session.cart.push({
            productId: pid,
            productName: product.productName,
            price: product.price,
            quantity: quantityToAdd,
            image: product.image,
            });
        }

        saveCartToDB(req.session.user.id, req.session.cart, (saveErr) => {
            if (saveErr) console.error('Cart DB save error:', saveErr);
            res.redirect('/cart');
        });
        });
    },

    // Update quantity (for +/- and manual input) WITH stock check
    update(req, res) {
        const productId = parseInt(req.params.id, 10);
        let quantity = parseInt(req.body.quantity, 10);

        if (!req.session.cart) {
        req.flash('messages', ['Cart is empty.']);
        return res.redirect('/cart');
        }

        const item = req.session.cart.find(i => i.productId === productId);
        if (!item) {
        req.flash('messages', ['Item not found in cart.']);
        return res.redirect('/cart');
        }

        // Normalize quantity
        if (isNaN(quantity)) quantity = item.quantity;
        if (quantity < 1) quantity = 1;

        // Check stock from DB
        Product.getById(productId, (err, product) => {
        if (err || !product) {
            req.flash('messages', ['Product not found / DB error.']);
            return res.redirect('/cart');
        }

        if (quantity > product.quantity) {
            quantity = product.quantity;
            req.flash('messages', [`Not enough stock. Max available: ${product.quantity}.`]);
        }

        item.quantity = quantity;

        saveCartToDB(req.session.user.id, req.session.cart, (saveErr) => {
            if (saveErr) console.error('Cart DB save error:', saveErr);
            res.redirect('/cart');
        });
        });
    },

    // Remove item from cart and update DB
    delete(req, res) {
        const productId = parseInt(req.params.id, 10);
        if (!req.session.cart) {
        req.flash('messages', ['Cart is empty.']);
        return res.redirect('/cart');
        }

        const before = req.session.cart.length;
        req.session.cart = req.session.cart.filter(i => i.productId !== productId);

        if (before === req.session.cart.length) {
        req.flash('messages', ['Item not found in cart.']);
        return res.redirect('/cart');
        }

        saveCartToDB(req.session.user.id, req.session.cart, (saveErr) => {
        if (saveErr) console.error('Cart DB save error:', saveErr);
        res.redirect('/cart');
        });
    },

    // Show cart
    list(req, res) {
        const cart = req.session.cart || [];
        res.render('cart', {
        cart,
        user: req.session.user,
        messages: req.flash('messages'),
        });
    },

    // Load persistent cart from DB after login
    loadCartToSession(req, cb) {
        getCartFromDB(req.session.user.id, (err, cart) => {
        req.session.cart = cart || [];
        cb(err);
        });
    },

    /**
     * Clear cart from both places after order OR from route
     * Supports:
     * - clearCartAll(req, cb)
     * - clearCartAll(req, res)
     */
    clearCartAll(req, resOrCb) {
        const userId = req.session?.user?.id;
        req.session.cart = [];

        if (!userId) {
        if (typeof resOrCb === 'function') return resOrCb(null);
        return resOrCb.redirect('/cart');
        }

        clearCartDB(userId, (err) => {
        if (err) console.error('Cart DB clear error:', err);

        if (typeof resOrCb === 'function') return resOrCb(err);
        req.flash('messages', ['Cart cleared!']);
        return resOrCb.redirect('/cart');
        });
    },
    };

    module.exports = CartController;
