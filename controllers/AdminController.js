const Product = require('../models/Product');
const Order = require('../models/Order');

const AdminController = {
    dashboard: function(req, res) {
        Product.getAll(function(err, products) {
            if (err) return res.status(500).send('Database error');
            Order.getAll(function(err, orders) {
                if (err) return res.status(500).send('Database error');
                res.render('adminDashboard', {
                    user: req.session.user,
                    products: products,
                    orders: orders
                });
            });
        });
    }
    // You can add more admin-only functions here!
};

module.exports = AdminController;
