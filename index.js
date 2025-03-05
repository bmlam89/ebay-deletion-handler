const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const crypto = require('crypto'); // Add this for challenge code hashing
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Create a schema for deletion notifications
const deletionSchema = new mongoose.Schema({
  username: String,
  userId: String,
  eiasToken: String,
  notificationId: String,
  eventDate: Date,
  publishDate: Date,
  publishAttemptCount: Number,
  rawNotification: Object,
  processed: { type: Boolean, default: false },
  processedDate: Date
});

const DeletionNotification = mongoose.model('DeletionNotification', deletionSchema);

// Create the DeletionLog schema
const deletionLogSchema = new mongoose.Schema({
  username: String,
  userId: String,
  eiasToken: String,
  deletionDate: { type: Date, default: Date.now },
  status: { 
    type: String, 
    enum: ['started', 'completed', 'failed', 'completed_with_errors'],
    default: 'started'
  },
  details: mongoose.Schema.Types.Mixed
}, { timestamps: true });

const DeletionLog = mongoose.model('DeletionLog', deletionLogSchema);

// Verification token for eBay
const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN;
// Your endpoint URL that you provided to eBay (this should also be in your .env file)
const ENDPOINT_URL = process.env.EBAY_ENDPOINT_URL;

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    // Create indexes after successful connection
    createIndexes();
  })
  .catch(err => console.error('Failed to connect to MongoDB:', err));

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
    
    // Create hash with the values in the required order: challengeCode + verificationToken + endpoint
    const hash = crypto.createHash('sha256');
    hash.update(challengeCode);
    hash.update(VERIFICATION_TOKEN);
    hash.update(ENDPOINT_URL);
    const responseHash = hash.digest('hex');
    
    console.log(`Generated challenge response: ${responseHash}`);
    
    // Set content-type header and respond with the proper hash format
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ 
      challengeResponse: responseHash 
    });
  } else {
    return res.status(400).send('Missing challenge_code parameter');
  }
});

// POST is used for actual deletion notifications
app.post('/api/ebay/deletion-notification', async (req, res) => {
  console.log('Received notification from eBay:', JSON.stringify(req.body));
  
  // Check for challenge in the request body (for verification)
  if (req.body && req.body.challenge) {
    console.log(`Received challenge in POST: ${req.body.challenge}`);
    
    // Create hash for challenge in POST request body too
    const hash = crypto.createHash('sha256');
    hash.update(req.body.challenge);
    hash.update(VERIFICATION_TOKEN);
    hash.update(ENDPOINT_URL);
    const responseHash = hash.digest('hex');
    
    return res.status(200).json({ challengeResponse: responseHash });
  }
  
  // Check verification token from eBay headers if needed
  const requestToken = req.headers['x-ebay-signature-key'] || 
                      req.headers['x-ebay-signature'] || 
                      req.headers['ebay-signature-key'] ||
                      req.headers['ebay-signature'] ||
                      req.headers['authorization'];
  
  // Remove "Bearer " prefix if it exists
  const cleanToken = requestToken && requestToken.startsWith('Bearer ') 
    ? requestToken.substring(7) 
    : requestToken;
  
  if (VERIFICATION_TOKEN && cleanToken !== VERIFICATION_TOKEN) {
    console.warn('Invalid verification token received:', cleanToken);
    // Log the issue but still process the notification
  }
  
  try {
    // Validate that this is an eBay marketplace account deletion notification
    if (req.body.metadata && 
        req.body.metadata.topic === "MARKETPLACE_ACCOUNT_DELETION" && 
        req.body.notification && 
        req.body.notification.data) {
      
      const notificationData = req.body.notification;
      const userData = notificationData.data;
      
      // Extract user identifiers from notification
      const username = userData.username;
      const userId = userData.userId;
      const eiasToken = userData.eiasToken;
      const notificationId = notificationData.notificationId;

      console.log(`Processing deletion request for user: ${username}, ID: ${userId}`);
      
      // Save the notification to MongoDB
      const notification = new DeletionNotification({
        username: username,
        userId: userId,
        eiasToken: eiasToken,
        notificationId: notificationId,
        eventDate: new Date(notificationData.eventDate),
        publishDate: new Date(notificationData.publishDate),
        publishAttemptCount: notificationData.publishAttemptCount,
        rawNotification: req.body
      });
      
      await notification.save();
      console.log(`Saved deletion notification: ${notificationId}`);
      
      // Process the deletion
      await processUserDeletion(username, userId, eiasToken);
      
      // Update the notification to mark it as processed
      await DeletionNotification.findOneAndUpdate(
        { notificationId: notificationId },
        { 
          processed: true, 
          processedDate: new Date() 
        }
      );
      
      // Return 200 OK to acknowledge receipt
      return res.status(200).send();
    } else {
      console.warn('Received notification with unexpected format:', req.body);
      // Still respond with 200 so eBay knows we received it
      return res.status(200).send();
    }
  } catch (error) {
    console.error('Error processing notification:', error);
    // Still respond with 200 so eBay knows we received it
    return res.status(200).send();
  }
});

/**
 * Process user data deletion across all collections
 * @param {string} username - The eBay username
 * @param {string} userId - The eBay user ID
 * @param {string} eiasToken - The eBay EIAS token
 * @returns {Promise<boolean>} - Resolution status of the deletion
 */
async function processUserDeletion(username, userId, eiasToken) {
  console.log(`Starting deletion process for eBay user: ${username} (${userId})`);
  
  try {
    // Get a reference to the MongoDB database
    const db = mongoose.connection.db;
    
    // 1. Create a deletion log entry to document compliance
    const deletionLog = new DeletionLog({
      username: username,
      userId: userId,
      eiasToken: eiasToken,
      status: 'started',
      details: { startTime: new Date() }
    });
    
    await deletionLog.save();
    console.log(`Created deletion log for user ${userId}`);

    // 2. Get a list of all collections in the database
    // This allows us to scan all collections for user data
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    console.log(`Scanning ${collectionNames.length} collections for user data`);
    
    // Track statistics for reporting
    const deletionStats = {
      collectionsScanned: 0,
      documentsDeleted: 0,
      documentsAnonymized: 0,
      errors: []
    };

    // 3. For each collection, delete or anonymize user data
    for (const collectionName of collectionNames) {
      // Skip system collections and the DeletionNotification/DeletionLog collections
      if (collectionName.startsWith('system.') || 
          collectionName === 'DeletionNotifications' || 
          collectionName === 'DeletionLogs') {
        continue;
      }
      
      deletionStats.collectionsScanned++;
      const collection = db.collection(collectionName);
      
      try {
        // Look for documents with any of the user identifiers
        // This assumes your data model uses standard field names for user IDs
        // Adjust as needed for your specific data model
        const userFields = [
          { 'userId': userId },
          { 'user.id': userId },
          { 'user._id': userId },
          { 'username': username },
          { 'user.username': username },
          { 'eiasToken': eiasToken },
          { 'ebayUserId': userId },
          { 'ebayUsername': username }
        ];
        
        // Find documents associated with this user
        const query = { $or: userFields };
        const userDocuments = await collection.find(query).toArray();
        
        console.log(`Found ${userDocuments.length} documents in ${collectionName} collection`);
        
        if (userDocuments.length > 0) {
          // Option 1: Delete the documents completely
          const deleteResult = await collection.deleteMany(query);
          deletionStats.documentsDeleted += deleteResult.deletedCount;
          console.log(`Deleted ${deleteResult.deletedCount} documents from ${collectionName}`);
          
          // Option 2 (Alternative): Anonymize the documents instead of deleting
          // Uncomment and modify this section if you prefer anonymization for certain collections
          /*
          const anonymizationUpdate = {
            $set: {
              username: 'DELETED_USER',
              userId: 'DELETED_USER_' + Math.random().toString(36).substring(2, 10),
              email: null,
              // Add other personally identifiable fields that should be anonymized
              personalDataRemoved: true,
              personalDataRemovedDate: new Date()
            }
          };
          
          const anonymizeResult = await collection.updateMany(query, anonymizationUpdate);
          deletionStats.documentsAnonymized += anonymizeResult.modifiedCount;
          console.log(`Anonymized ${anonymizeResult.modifiedCount} documents in ${collectionName}`);
          */
        }
      } catch (collectionError) {
        console.error(`Error processing collection ${collectionName}:`, collectionError);
        deletionStats.errors.push({
          collection: collectionName,
          error: collectionError.message
        });
      }
    }
    
    // 4. Update the deletion log with results
    await DeletionLog.findOneAndUpdate(
      { username: username, userId: userId },
      { 
        status: deletionStats.errors.length > 0 ? 'completed_with_errors' : 'completed',
        details: {
          ...deletionLog.details,
          completionTime: new Date(),
          statistics: deletionStats
        }
      }
    );
    
    console.log(`Completed deletion process for user ${username}:`, deletionStats);
    
    return true;
  } catch (error) {
    console.error(`Error during deletion process for user ${username}:`, error);
    
    // Log the error to the deletion log if possible
    try {
      await DeletionLog.findOneAndUpdate(
        { username: username, userId: userId },
        { 
          status: 'failed',
          details: {
            error: error.message,
            stack: error.stack,
            timestamp: new Date()
          }
        }
      );
    } catch (logError) {
      console.error('Failed to update deletion log:', logError);
    }
    
    throw error;
  }
}

/**
 * Create indexes on important user identifier fields
 * This improves performance when searching for user data during deletion
 */
async function createIndexes() {
  try {
    // First ensure collections exist by inserting and then removing a dummy document
    // This is a common pattern to ensure a collection exists before creating indexes
    
    // 1. Create DeletionNotification collection if it doesn't exist
    try {
      // Check if the collection exists first
      const collections = await mongoose.connection.db.listCollections({ name: 'deletionnotifications' }).toArray();
      if (collections.length === 0) {
        console.log('Creating DeletionNotification collection');
        // Insert a dummy document to create the collection
        const dummyNotification = new DeletionNotification({
          username: 'dummy',
          userId: 'dummy',
          eiasToken: 'dummy',
          notificationId: 'dummy',
          eventDate: new Date(),
          publishDate: new Date(),
          publishAttemptCount: 0,
          rawNotification: {},
          processed: true,
          processedDate: new Date()
        });
        await dummyNotification.save();
        
        // Then remove it
        await DeletionNotification.deleteOne({ notificationId: 'dummy' });
      }
    } catch (error) {
      console.log('Error handling DeletionNotification collection creation:', error);
    }
    
    // 2. Create DeletionLog collection if it doesn't exist
    try {
      // Check if the collection exists first
      const collections = await mongoose.connection.db.listCollections({ name: 'deletionlogs' }).toArray();
      if (collections.length === 0) {
        console.log('Creating DeletionLog collection');
        // Insert a dummy document to create the collection
        const dummyLog = new DeletionLog({
          username: 'dummy',
          userId: 'dummy',
          eiasToken: 'dummy',
          status: 'started',
          details: { dummy: true }
        });
        await dummyLog.save();
        
        // Then remove it
        await DeletionLog.deleteOne({ userId: 'dummy' });
      }
    } catch (error) {
      console.log('Error handling DeletionLog collection creation:', error);
    }
    
    // Now create indexes on existing collections
    
    // 3. Index for DeletionNotification collection
    try {
      const deletionNotificationIndexes = await DeletionNotification.collection.getIndexes();
      
      // Check if indexes already exist before creating them
      if (!deletionNotificationIndexes.userId_1) {
        await DeletionNotification.collection.createIndex({ userId: 1 });
        console.log('Created index on DeletionNotification.userId');
      }
      
      if (!deletionNotificationIndexes.username_1) {
        await DeletionNotification.collection.createIndex({ username: 1 });
        console.log('Created index on DeletionNotification.username');
      }
      
      if (!deletionNotificationIndexes.notificationId_1) {
        await DeletionNotification.collection.createIndex({ notificationId: 1 }, { unique: true });
        console.log('Created unique index on DeletionNotification.notificationId');
      }
    } catch (error) {
      console.log('Error creating DeletionNotification indexes:', error);
    }
    
    // 4. Index for DeletionLog collection
    try {
      const deletionLogIndexes = await DeletionLog.collection.getIndexes();
      
      if (!deletionLogIndexes.userId_1) {
        await DeletionLog.collection.createIndex({ userId: 1 });
        console.log('Created index on DeletionLog.userId');
      }
      
      if (!deletionLogIndexes.username_1) {
        await DeletionLog.collection.createIndex({ username: 1 });
        console.log('Created index on DeletionLog.username');
      }
    } catch (error) {
      console.log('Error creating DeletionLog indexes:', error);
    }
    
    console.log('Index creation process completed');
  } catch (error) {
    console.error('Error in index creation process:', error);
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});