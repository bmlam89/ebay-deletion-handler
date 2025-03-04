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

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

// eBay account deletion notification endpoint
app.post('/ebay-deletion-notification', (req, res) => {
  console.log('Received notification from eBay:', req.body);
  
  // Check verification token from eBay headers
  const requestToken = req.headers['x-ebay-signature'];
  
  if (requestToken !== VERIFICATION_TOKEN) {
    console.warn('Invalid verification token received:', requestToken);
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