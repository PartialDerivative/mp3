// Get the packages we need
var express = require('express'),
    router = express.Router(),
    mongoose = require('mongoose');

// Read .env file
require('dotenv').config();

// Create our Express application
var app = express();

// Use environment defined port or 3000
var port = process.env.PORT || 3000;

// Connect to MongoDB (connection string comes from .env locally, or Render's environment variables)
mongoose.connect(process.env.MONGODB_URI).catch(function (err) { console.error('MongoDB connection error:', err.message); });

// Allow CORS so that backend and frontend could be put on different servers
var allowCrossDomain = function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    next();
};
app.use(allowCrossDomain);

// Parse URL-encoded and JSON request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Use routes as a module (see index.js)
require('./routes')(app, router);

// Unknown URL: still answer in { message, data } format
app.use(function (req, res) {
    res.status(404).json({ message: 'Endpoint not found.', data: {} });
});

// Errors thrown before our routes run, e.g. a request body that is not valid JSON
app.use(function (err, req, res, next) {
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ message: 'The request body is not valid JSON.', data: {} });
    }
    if (err.status && err.status < 500) {
        return res.status(err.status).json({ message: 'The request could not be processed.', data: {} });
    }
    console.error(err);
    res.status(500).json({ message: 'Something went wrong on the server. Please try again later.', data: {} });
});

// Start the server
app.listen(port);
console.log('Server running on port ' + port);
