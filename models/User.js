// ...existing code...
const db = require('../db');

const User = {
  // Get all users (omit password for safety)
  getAll(callback) {
    const sql = 'SELECT id, username, email, address, contact, role FROM users';
    db.query(sql, (err, results) => callback(err, results));
  },

  // Get username by email
  getUsernameByEmail(email, callback) {
    const sql = 'SELECT username FROM users WHERE email = ?';
    db.query(sql, [email], (err, results) => {
      if (err) return callback(err);
      callback(null, results[0] ? results[0].username : null);
    });
  },

  // Get full user record by ID (omits password unless explicitly needed)
  getById(id, callback) {
    const sql = 'SELECT id, username, email, address, contact, role FROM users WHERE id = ?';
    db.query(sql, [id], (err, results) => {
      if (err) return callback(err);
      callback(null, results[0] || null);
    });
  },

  // Add a new user (expects password already hashed by caller if required)
  add(user, callback) {
    const sql = 'INSERT INTO users (username, email, password, address, contact, role) VALUES (?, ?, ?, ?, ?, ?)';
    const params = [
      user.username,
      user.email,
      user.password,
      user.address || null,
      user.contact || null,
      user.role || 'user'
    ];
    db.query(sql, params, (err, results) => callback(err, results));
  },

  // Update existing user (password can be changed by passing a new hashed password)
  update(id, user, callback) {
    const sql = 'UPDATE users SET username = ?, email = ?, password = ?, address = ?, contact = ?, role = ? WHERE id = ?';
    const params = [
      user.username,
      user.email,
      user.password,
      user.address || null,
      user.contact || null,
      user.role || 'user',
      id
    ];
    db.query(sql, params, (err, results) => callback(err, results));
  },

  // Delete user by id
  delete(id, callback) {
    const sql = 'DELETE FROM users WHERE id = ?';
    db.query(sql, [id], (err, results) => callback(err, results));
  }
};

module.exports = User;
// ...existing code...