// ...existing code...
const Product = require('../models/Product');

    const ProductController = {
    // List products and render appropriate view (inventory for admins, shopping for users)
    list(req, res) {
        Product.getAll((err, products) => {
        if (err) {
            req.flash('error', 'Database error');
            return res.status(500).redirect('/');
        }

        // choose view based on path (inventory vs shopping)
        const path = (req.originalUrl || req.path || '').toLowerCase();
        if (path.includes('/inventory')) {
            return res.render('inventory', { products, user: req.session.user, messages: req.flash('success'), errors: req.flash('error') });
        } else {
            return res.render('shopping', { products, user: req.session.user });
        }
        });
    },

    // Get product by ID and render product view or update form depending on route
    getById(req, res) {
        const id = req.params.id;
        Product.getById(id, (err, product) => {
        if (err) {
            req.flash('error', 'Database error');
            return res.status(500).redirect('/');
        }
        if (!product) {
            req.flash('error', 'Product not found');
            return res.status(404).redirect('/shopping');
        }

        const path = (req.originalUrl || req.path || '').toLowerCase();
        if (path.includes('/updateproduct')) {
            return res.render('updateProduct', { product, user: req.session.user, messages: req.flash('success'), errors: req.flash('error') });
        } else {
            return res.render('product', { product, user: req.session.user });
        }
        });
    },

    // Add new product (handles file upload via multer)
    add(req, res) {
        const fileImage = req.file ? req.file.filename : (req.body.image || null);
        const product = {
        productName: req.body.productName,
        quantity: parseInt(req.body.quantity, 10) || 0,
        price: parseFloat(req.body.price) || 0,
        image: fileImage
        };

        Product.add(product, (err, result) => {
        if (err) {
            req.flash('error', 'Failed to create product');
            return res.status(500).redirect('/addProduct');
        }
        req.flash('success', 'Product created');
        return res.redirect('/inventory');
        });
    },

    // Update existing product (handles file upload via multer)
    update(req, res) {
        const id = req.params.id;
        const fileImage = req.file ? req.file.filename : (req.body.image || null);
        const product = {
        productName: req.body.productName,
        quantity: parseInt(req.body.quantity, 10) || 0,
        price: parseFloat(req.body.price) || 0,
        image: fileImage
        };

        Product.update(id, product, (err, result) => {
        if (err) {
            req.flash('error', 'Failed to update product');
            return res.status(500).redirect(`/updateProduct/${id}`);
        }
        if (result && result.affectedRows === 0) {
            req.flash('error', 'Product not found');
            return res.status(404).redirect('/inventory');
        }
        req.flash('success', 'Product updated');
        return res.redirect('/inventory');
        });
    },

    // Delete product and redirect back to inventory
    delete(req, res) {
        const id = req.params.id;
        Product.delete(id, (err, result) => {
        if (err) {
            req.flash('error', 'Failed to delete product');
            return res.status(500).redirect('/inventory');
        }
        if (result && result.affectedRows === 0) {
            req.flash('error', 'Product not found');
            return res.status(404).redirect('/inventory');
        }
        req.flash('success', 'Product deleted');
        return res.redirect('/inventory');
        });
    }
    };

    module.exports = ProductController;
    // ...existing code...