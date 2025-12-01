const Product = require('../models/Product');

const ProductController = {
    // List products and render appropriate view (inventory for admins, shopping for users)
    list(req, res) {
        Product.getAll((err, products) => {
            if (err) {
                req.flash('error', 'Database error');
                return res.status(500).redirect('/');
            }
            const path = (req.originalUrl || req.path || '').toLowerCase();
            if (path.includes('/inventory')) {
                return res.render('inventory', {
                    products,
                    user: req.session.user,
                    messages: req.flash('success'),
                    errors: req.flash('error')
                });
            } else {
                return res.render('shopping', {
                    products,
                    user: req.session.user,
                    // flash messages used for stock warnings etc.
                    messages: req.flash('messages')
                });
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
                return res.render('updateProduct', {
                    product,
                    user: req.session.user,
                    messages: req.flash('success'),
                    errors: req.flash('error')
                });
            } else {
                return res.render('product', {
                    product,
                    user: req.session.user
                });
            }
        });
    },

    // Add new product (handles file upload via multer)
    add(req, res) {
        console.log('Received add form:', req.body);

        // Image is required for new products
        const fileImage = req.file ? req.file.filename : null;
        const productName = req.body.productName;
        const quantity = parseInt(req.body.quantity, 10);
        const price = parseFloat(req.body.price);

        // Validate input: image, name, quantity, price
        if (!productName || isNaN(quantity) || quantity < 0 || isNaN(price) || price < 0 || !fileImage) {
            req.flash('error', 'All fields including a valid image, quantity, and price are required.');
            return res.redirect('/addProduct');
        }

        const product = {
            productName,
            quantity,
            price,
            image: fileImage
        };

        Product.add(product, (err, result) => {
            console.log('Add DB result:', err, result);

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
        console.log('Received update form:', req.body);

        const id = req.params.id;
        // If no new file, keep old image
        const fileImage =
            req.file && req.file.filename
                ? req.file.filename
                : req.body.currentImage; // Fallback to current image

        const productName = req.body.productName;
        const quantity = parseInt(req.body.quantity, 10);
        const price = parseFloat(req.body.price);

        // Validation before update
        if (!productName || isNaN(quantity) || quantity < 0 || isNaN(price) || price < 0 || !fileImage) {
            req.flash('error', 'All fields (including positive quantity, price, and image) are required.');
            return res.redirect(`/updateProduct/${id}`);
        }

        const product = {
            productName,
            quantity,
            price,
            image: fileImage
        };

        Product.update(id, product, (err, result) => {
            console.log('Update DB result:', err, result);

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
