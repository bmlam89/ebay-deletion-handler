const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('Failed to connect to MongoDB:', err));

// Create a schema for deletion notifications
const deletionSchema = new mongoose.Schema({
  userId: String,
  timestamp: { type: Date, default: Date.now },
  notificationData: Object
});

const DeletionNotification = mongoose.model('DeletionNotification', deletionSchema);

// Verification token for eBay
const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN;

// Root endpoint
app.get('/', (req, res) => {
  res.send('eBay Deletion Handler Service');
});

// API root endpoint
app.get('/api/ebay', (req, res) => {
  res.send('eBay Deletion Handler API');
});

// Health check endpoint
app.get('/api/ebay/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

// eBay account deletion notification endpoint - handle both GET and POST
// GET is used by eBay for verification
app.get('/api/ebay/deletion-notification', (req, res) => {
  console.log('Received GET verification request from eBay');
  
  // Check if this is a challenge request
  const challengeCode = req.query.challenge_code;
  
  if (challengeCode) {
    console.log(`Received challenge code: ${challengeCode}`);
    // Simply respond with the same challenge code
    return res.status(200).json({ challengeResponse: challengeCode });
  } else {
    return res.status(400).send('Missing challenge_code parameter');
  }
});

// POST is used for actual deletion notifications
app.post('/api/ebay/deletion-notification', (req, res) => {
  console.log('Received notification from eBay:', req.body);
  
  // Check for challenge in the request body (for verification)
  if (req.body && req.body.challenge) {
    console.log(`Received challenge in POST: ${req.body.challenge}`);
    return res.status(200).json({ challengeResponse: req.body.challenge });
  }
  
  // Check verification token from eBay headers - check multiple possible header names
  const requestToken = req.headers['x-ebay-signature-key'] || 
                      req.headers['x-ebay-signature'] || 
                      req.headers['ebay-signature-key'] ||
                      req.headers['ebay-signature'] ||
                      req.headers['authorization'];
  
  // Remove "Bearer " prefix if it exists
  const cleanToken = requestToken && requestToken.startsWith('Bearer ') 
    ? requestToken.substring(7) 
    : requestToken;
  
  if (cleanToken !== VERIFICATION_TOKEN) {
    console.warn('Invalid verification token received:', cleanToken);
    // Still return 200 so eBay knows we received the notification
    return res.status(200).send('Received but token verification failed');
  }
  
  try {
    // Extract the userId from the notification
    // The exact structure may depend on eBay's actual notification format
    const userId = req.body.userId || 
                  (req.body.data && req.body.data.userId) || 
                  'unknown-user';
    
    // Save the notification to MongoDB
    const notification = new DeletionNotification({
      userId: userId,
      notificationData: req.body
    });
    
    notification.save()
      .then(() => {
        console.log(`Saved deletion notification for user ${userId}`);
        
        // Future implementation: Add code here to delete user data
        console.log(`TODO: Implement data deletion for user ${userId}`);
      })
      .catch(err => {
        console.error('Error saving notification:', err);
      });
    
    // Always respond with 200 OK to acknowledge receipt
    return res.status(200).send('Notification received successfully');
  } catch (error) {
    console.error('Error processing notification:', error);
    // Still respond with 200 so eBay knows we received it
    return res.status(200).send('Notification received with processing errors');
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});