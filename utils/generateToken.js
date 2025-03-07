const jwt = require('jsonwebtoken');

const generateToken = (user, expiresIn) =>
    jwt.sign(user, process.env.JWT_SECRET_KEY, { expiresIn });

module.exports = generateToken;