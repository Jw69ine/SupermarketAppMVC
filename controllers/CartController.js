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

            const existing = req.session.cart.find(
                item => item.productId === parseInt(productId, 10)
            );
            const currentQtyInCart = existing ? existing.quantity : 0;
            const newTotalQty = currentQtyInCart + quantityToAdd;

            // Stock check: do not allow more than available inventory
            if (newTotalQty > product.quantity) {
                req.flash(
                    'messages',
                    [`Not enough stock. Available: ${product.quantity}, in cart: ${currentQtyInCart}.`]
                );
                return res.redirect('/shopping');
            }

            if (existing) {
                existing.quantity = newTotalQty;
            } else {
                req.session.cart.push({
                    productId: parseInt(productId, 10),
                    productName: product.productName,
                    price: product.price,
                    quantity: quantityToAdd,
                    image: product.image
                });
            }

            // Sync to DB after session update
            saveCartToDB(req.session.user.id, req.session.cart, (err) => {
                if (err) console.error('Cart DB save error:', err);
                res.redirect('/cart');
            });
        });
    },

    // Update quantity
    update(req, res) {
        const productId = parseInt(req.params.id, 10);
        const quantity = parseInt(req.body.quantity, 10);

        if (!req.session.cart) return res.status(400).json({ error: 'Cart is empty' });

        const item = req.session.cart.find(i => i.productId === productId);
        if (!item) return res.status(404).json({ error: 'Item not found in cart' });

        if (isNaN(quantity) || quantity < 1) {
            req.session.cart = req.session.cart.filter(i => i.productId !== productId);
        } else {
            item.quantity = quantity;
        }

        saveCartToDB(req.session.user.id, req.session.cart, (err) => {
            if (err) console.error('Cart DB save error:', err);
            res.redirect('/cart');
        });
    },

    // Remove item from cart and update DB
    delete(req, res) {
        const productId = parseInt(req.params.id, 10);
        if (!req.session.cart) return res.status(400).json({ error: 'Cart is empty' });

        const before = req.session.cart.length;
        req.session.cart = req.session.cart.filter(i => i.productId !== productId);

        // If no item was removed, inform client
        if (before === req.session.cart.length) {
            return res.status(404).json({ error: 'Item not found in cart' });
        }

        // Save to DB after session update
        saveCartToDB(req.session.user.id, req.session.cart, (err) => {
            if (err) console.error('Cart DB save error:', err);
            res.redirect('/cart');
        });
    },

    // Show cart
    list(req, res) {
        const cart = req.session.cart || [];
        res.render('cart', {
            cart,
            user: req.session.user,
            messages: req.flash('messages') // support feedback like "Cart cleared!" or stock errors
        });
    },

    // Load persistent cart from DB after login
    loadCartToSession(req, cb) {
        getCartFromDB(req.session.user.id, (err, cart) => {
            req.session.cart = cart || [];
            cb(err);
        });
    },

    // Clear cart from both places after order
    clearCartAll(req, cb) {
        req.session.cart = [];
        clearCartDB(req.session.user.id, (err) => {
            if (err) console.error('Cart DB clear error:', err);
            cb && cb(err);
        });
    }
};

module.exports = CartController;
