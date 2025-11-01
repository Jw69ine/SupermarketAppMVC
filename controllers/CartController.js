// ...existing code...
const Product = require('../models/Product');

const CartController = {
    // List all available products (uses Product model)
    listProducts(req, res) {
        Product.getAll((err, products) => {
        if (err) return res.status(500).json({ error: 'Database error', details: err });
        // render shopping view with product list
        res.render('shopping', { products, user: req.session.user });
        });
    },

    // Get a single product by ID (uses Product model)
    getProductById(req, res) {
        const id = req.params.id;
        Product.getById(id, (err, product) => {
        if (err) return res.status(500).json({ error: 'Database error', details: err });
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.render('product', { product, user: req.session.user });
        });
    },

    // Add product to session cart (uses Product model for details)
    add(req, res) {
        const productId = req.params.id;
        const quantity = parseInt(req.body.quantity, 10) || 1;

        Product.getById(productId, (err, product) => {
        if (err) return res.status(500).json({ error: 'Database error', details: err });
        if (!product) return res.status(404).json({ error: 'Product not found' });

        if (!req.session.cart) req.session.cart = [];

        const existing = req.session.cart.find(item => item.productId === parseInt(productId, 10));
        if (existing) {
            existing.quantity += quantity;
        } else {
            req.session.cart.push({
            productId: parseInt(productId, 10),
            productName: product.productName,
            price: product.price,
            quantity,
            image: product.image
            });
        }

        res.redirect('/cart');
        });
    },

    // Update an item in the session cart (quantity)
    update(req, res) {
        const productId = parseInt(req.params.id, 10);
        const quantity = parseInt(req.body.quantity, 10);

        if (!req.session.cart) return res.status(400).json({ error: 'Cart is empty' });

        const item = req.session.cart.find(i => i.productId === productId);
        if (!item) return res.status(404).json({ error: 'Item not found in cart' });

        if (isNaN(quantity) || quantity < 1) {
        // remove item if quantity invalid or zero
        req.session.cart = req.session.cart.filter(i => i.productId !== productId);
        } else {
        item.quantity = quantity;
        }

        res.redirect('/cart');
    },

    // Delete an item from the session cart
    delete(req, res) {
        const productId = parseInt(req.params.id, 10);
        if (!req.session.cart) return res.status(400).json({ error: 'Cart is empty' });

        const before = req.session.cart.length;
        req.session.cart = req.session.cart.filter(i => i.productId !== productId);
        const after = req.session.cart.length;

        if (before === after) return res.status(404).json({ error: 'Item not found in cart' });

        res.redirect('/cart');
    },

    // Render cart page (helper)
    list(req, res) {
        const cart = req.session.cart || [];
        res.render('cart', { cart, user: req.session.user });
    }
    };

    module.exports = CartController;
    // ...existing code...