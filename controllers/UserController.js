// controllers/UserController.js

const crypto = require('crypto');
const User = require('../models/User');

// UserController object
const UserController = {
    // List all users (returns JSON, for API/testing)
    list(req, res) {
        User.getAll((err, users) => {
            if (err) return res.status(500).json({ error: 'Database error', details: err });
            return res.json(users);
        });
    },

    // Show user's profile for admin view (EJS)
showProfile(req, res) {
    const id = req.params.id;
    User.getById(id, (err, userProfile) => {
        if (err) return res.status(500).send('Database error');
        if (!userProfile) return res.status(404).send('User not found');
        res.render('userProfile', { 
            userProfile: userProfile,           // user whose profile is displayed
            user: req.session.user              // logged-in admin, for navbar
        });
    });
},

    // Get a single user by ID (returns JSON, for API/testing)
    getById(req, res) {
        const id = req.params.id;
        User.getById(id, (err, user) => {
            if (err) return res.status(500).json({ error: 'Database error', details: err });
            if (!user) return res.status(404).json({ error: 'User not found' });
            return res.json(user);
        });
    },

    // Add a new user (hashes password and redirects to login on success)
    add(req, res) {
        const { username, email, password, address, contact, role } = req.body;
        if (!username || !email || !password) {
            req.flash('error', 'Username, email and password are required');
            req.flash('formData', req.body);
            return res.redirect('/register');
        }
        const hashed = crypto.createHash('sha1').update(password).digest('hex');
        const user = {
            username,
            email,
            password: hashed,
            address: address || null,
            contact: contact || null,
            role: role || 'user'
        };

        User.add(user, (err, result) => {
            if (err) {
                req.flash('error', 'Failed to create user');
                req.flash('formData', req.body);
                return res.status(500).redirect('/register');
            }
            req.flash('success', 'Registration successful. Please log in.');
            return res.redirect('/login');
        });
    },

    // Update existing user (expects password if changing; hashes it)
    update(req, res) {
        const id = req.params.id;
        const { username, email, password, address, contact, role } = req.body;
        const hashed = password ? crypto.createHash('sha1').update(password).digest('hex') : null;
        const user = {
            username,
            email,
            password: hashed,
            address: address || null,
            contact: contact || null,
            role: role || 'user'
        };

        User.update(id, user, (err, result) => {
            if (err) {
                return res.status(500).json({ error: 'Database error', details: err });
            }
            if (result && result.affectedRows === 0) {
                return res.status(404).json({ error: 'User not found' });
            }
            return res.json({ message: 'User updated' });
        });
    },

    // Delete a user
    delete(req, res) {
        const id = req.params.id;
        User.delete(id, (err, result) => {
            if (err) return res.status(500).json({ error: 'Database error', details: err });
            if (result && result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
            return res.json({ message: 'User deleted' });
        });
    }
};

module.exports = UserController;
