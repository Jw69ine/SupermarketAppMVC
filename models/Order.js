const db = require('../db');

const Order = {
    // Create order (default status: pending!)
    create(order, callback) {
        // Add status as default 'pending'
        const sql = 'INSERT INTO orders (userId, items, total, paymentMethod, status) VALUES (?, ?, ?, ?, ?)';
        const params = [
            order.userId,
            JSON.stringify(order.items),
            order.total,
            order.paymentMethod,
            order.status || 'pending'
        ];
        db.query(sql, params, callback);
    },

    // Get all orders by user
    getUserOrders(userId, callback) {
        const sql = 'SELECT * FROM orders WHERE userId = ? ORDER BY orderDate DESC';
        db.query(sql, [userId], (err, results) => {
            if (err) return callback(err);
            results.forEach(order => { order.items = JSON.parse(order.items); });
            callback(null, results);
        });
    },

    // Get one order by id
    getById(orderId, callback) {
        const sql = 'SELECT * FROM orders WHERE id = ?';
        db.query(sql, [orderId], (err, results) => {
            if (err || !results.length) return callback(err || new Error('Order not found'));
            const order = results[0];
            order.items = JSON.parse(order.items);
            callback(null, order);
        });
    },

    // Mark one order 'paid'
    updateStatus(orderId, status, callback) {
        const sql = 'UPDATE orders SET status = ? WHERE id = ?';
        db.query(sql, [status, orderId], callback);
    },

    // Admin: get all orders with usernames
    getAll(callback) {
        const sql = `
            SELECT orders.*, users.username, users.email
            FROM orders
            JOIN users ON orders.userId = users.id
            ORDER BY orderDate DESC
        `;
        db.query(sql, function(err, results) {
            if (err) return callback(err);
            results.forEach(function(order) {
                order.items = JSON.parse(order.items);
            });
            callback(null, results);
        });
    }
};

module.exports = Order;
