const db = require('../db');

const Product = {
    getAll(callback) {
        const sql = 'SELECT id, productName, quantity, price, image FROM products';
        db.query(sql, (err, results) => callback(err, results));
    },

    getById(id, callback) {
        const sql = 'SELECT id, productName, quantity, price, image FROM products WHERE id = ?';
        db.query(sql, [id], (err, results) => {
            if (err) return callback(err);
            callback(null, results[0] || null);
        });
    },

    add(product, callback) {
        const sql = 'INSERT INTO products (productName, quantity, price, image) VALUES (?, ?, ?, ?)';
        const params = [
            product.productName,
            product.quantity,
            product.price,
            product.image || null
        ];
        db.query(sql, params, (err, results) => callback(err, results));
    },

    update(id, product, callback) {
        const sql = 'UPDATE products SET productName = ?, quantity = ?, price = ?, image = ? WHERE id = ?';
        const params = [
            product.productName,
            product.quantity,
            product.price,
            product.image || null,
            id
        ];
        db.query(sql, params, (err, results) => callback(err, results));
    },

    delete(id, callback) {
        const sql = 'DELETE FROM products WHERE id = ?';
        db.query(sql, [id], (err, results) => callback(err, results));
    },

    decrementQuantity(id, qty, callback) {
        const sql = 'UPDATE products SET quantity = quantity - ? WHERE id = ?';
        db.query(sql, [qty, id], callback);
    }
};

module.exports = Product;
