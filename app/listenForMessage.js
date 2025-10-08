'use strict';

// Imports the Google Cloud client library
const {PubSub} = require('@google-cloud/pubsub');
const {Storage} = require('@google-cloud/storage');
const dotenv = require('dotenv');
const photoModel = require('./photo_model');
const request = require('request');
const { saveZipDataToFirebase } = require('./firebase');

dotenv.config();

// In-memory store for zip files (tags -> filename mapping)
// In production, use a database like Redis or Firestore
const zipFilesStore = new Map();


// Get authenticated client
// const authClient = getAuthClient();

// Creates a client; cache this for further use
const pubSubClient = new PubSub({
  projectId: process.env.PROJECT_ID
});

// Create Storage client with proper authentication
const storage = new Storage({
  projectId: process.env.PROJECT_ID,
});

// Function to process zip job
async function processZipJob(tags, prenom) {
  console.log(`\n[ZIP_JOB] Starting zip job for tags: "${tags}", user: "${prenom}"`);
  
  // Validate prenom parameter
  if (!prenom) {
    console.error('[ZIP_JOB] ✗ Prenom parameter is required for zip job');
  }
  
  try {
    // 1. Get photos from Flickr
    console.log(`[FLICKR] Fetching photos for tags: "${tags}"`);
    const photos = await photoModel.getFlickrPhotos(tags);
    
    if (!photos || photos.length === 0) {
      console.error(`[FLICKR] ✗ No photos found for tags: "${tags}"`);
    }
    
    // 2. Take only first 10 photos
    const photosToZip = photos.slice(0, 10);
    console.log(`[FLICKR] Found ${photos.length} photos, selecting first ${photosToZip.length} for zipping`);
    
    // 3. Create zip in memory
    console.log(`[ZIP] Creating zip archive in memory`);
    const ZipStream = require('zip-stream');
    const zip = new ZipStream.default();
    const chunks = [];
    
    // Collect zip data in memory
    zip.on('data', (chunk) => chunks.push(chunk));
    
    const zipPromise = new Promise((resolve, reject) => {
      zip.on('end', () => resolve(Buffer.concat(chunks)));
      zip.on('error', reject);
    });
    
    // 4. Add files to zip
    console.log(`[ZIP] Adding ${photosToZip.length} files to archive`);
    await addFilesToZip(zip, photosToZip);
    
    // Wait for zip to complete
    const zipBuffer = await zipPromise;
    console.log(`[ZIP] ✓ Archive created successfully, size: ${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    
    // 5. Upload to Google Cloud Storage
    const filename = `photos-${tags}-${Date.now()}.zip`;
    const bucketName = process.env.STORAGE_BUCKET;
    
    console.log(`[STORAGE] Configuration:`);
    console.log(`[STORAGE] - Bucket: ${bucketName}`);
    console.log(`[STORAGE] - Project: ${process.env.PROJECT_ID}`);
    console.log(`[STORAGE] - Filename: ${filename}`);
    
    if (!bucketName) {
      console.error('[STORAGE] ✗ STORAGE_BUCKET environment variable is not set');
    }
    
    console.log(`[STORAGE] Initializing bucket connection...`);
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filename);
    
    console.log(`[STORAGE] Starting upload to gs://${bucketName}/${filename}`);
    const stream = file.createWriteStream({
      metadata: {
        contentType: 'application/zip',
        cacheControl: 'private'
      },
      resumable: false
    });
    
    await new Promise((resolve, reject) => {
      stream.on('error', (err) => {
        console.error(`[STORAGE] ✗ Upload error:`, err.message);
        console.error(`[STORAGE] ✗ Please verify that the bucket "${bucketName}" exists in project "${process.env.PROJECT_ID}"`);
        reject(err);
      });
      
      stream.on('finish', () => {
        console.log(`[STORAGE] ✓ Upload completed successfully`);
        resolve('Ok');
      });
      
      stream.end(zipBuffer);
    });
    
    // 6. Generate signed URL for download (valid for 7 days)
    console.log(`[STORAGE] Generating signed URL (valid for 7 days)`);
    const [signedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    
    console.log(`[STORAGE] ✓ Signed URL generated successfully`);
    console.log(`[STORAGE]   URL: ${signedUrl.substring(0, 80)}...`);
    
    // Store the filename for this tags combination
    zipFilesStore.set(tags, filename);
    console.log(`[CACHE] Stored filename "${filename}" for tags "${tags}"`);
    
    // 7. Save data to Firebase Realtime Database
    const storagePath = `gs://${bucketName}/${filename}`;
    const photoLinks = photosToZip.map(photo => photo.media.m);
    
    console.log(`[FIREBASE] Saving zip data to Firebase Realtime Database`);
    console.log(`[FIREBASE] - Path: /${prenom}/<timestamp>/${filename}`);
    console.log(`[FIREBASE] - Photos count: ${photoLinks.length}`);
    
    await saveZipDataToFirebase(prenom, filename, signedUrl, storagePath, photoLinks);
    console.log(`[FIREBASE] ✓ Zip data saved successfully for user "${prenom}"`);

    console.log(`\n[ZIP_JOB] ✓ Job completed successfully for tags: "${tags}", user: "${prenom}"\n`);
    return signedUrl;
    
  } catch (error) {
    console.error(`\n[ZIP_JOB] ✗ Error processing zip job for tags "${tags}", user "${prenom}":`, error.message);
    console.error(`[ZIP_JOB] ✗ Error details:`, error);
    
    throw error;
  }
}

// Helper function to add files to zip
function addFilesToZip(zip, photos) {
  return new Promise((resolve, reject) => {
    let index = 0;
    
    function addNextFile() {
      if (index >= photos.length) {
        zip.finalize();
        console.log(`[ZIP] ✓ All files added, finalizing archive`);
        resolve();
        return;
      }
      
      const photo = photos[index];
      const filename = `photo-${index + 1}-${photo.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50)}.jpg`;
      
      console.log(`[ZIP] Adding file ${index + 1}/${photos.length}: ${filename}`);
      
      const stream = request(photo.media.m);
      
      zip.entry(stream, { name: filename }, (err) => {
        if (err) {
          console.error(`[ZIP] ✗ Error adding file ${filename}:`, err.message);
          reject(err);
          return;
        }
        index++;
        addNextFile();
      });
    }
    
    addNextFile();
  });
}


async function listenForMessages(subscriptionNameOrId) {
  // Get or create the subscription
  const topicName = process.env.TOPIC_NAME;
  const topic = pubSubClient.topic(topicName);
  
  let subscription = topic.subscription(subscriptionNameOrId);
  const [subscriptionExists] = await subscription.exists();
  
  if (!subscriptionExists) {
    console.log(`[PUBSUB] Subscription ${subscriptionNameOrId} does not exist. Creating it...`);
    [subscription] = await topic.createSubscription(subscriptionNameOrId);
    console.log(`[PUBSUB] ✓ Subscription ${subscriptionNameOrId} created successfully`);
  } else {
    console.log(`[PUBSUB] ✓ Using existing subscription: ${subscriptionNameOrId}`);
  }

  // Create an event handler to handle messages
  const messageHandler = async (message) => {
    console.log(`\n[PUBSUB] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`[PUBSUB] Received message ID: ${message.id}`);
    console.log(`[PUBSUB] Data: ${message.data.toString()}`);
    if (Object.keys(message.attributes).length > 0) {
      console.log(`[PUBSUB] Attributes:`, message.attributes);
    }
    
    try {
      const dataString = message.data.toString();
      let messageData;
      
      // Try to parse as JSON, if it fails, treat as plain text
      try {
        messageData = JSON.parse(dataString);
        console.log(`[PUBSUB] ✓ Parsed JSON data successfully:`, messageData);
      } catch (parseError) {
        messageData = { text: dataString };
        console.log(`[PUBSUB] Plain text message (not JSON)`);
      }
      
      // Process zip job if tags are provided
      if (messageData.tags && messageData.requestType === 'zip') {
        console.log(`[PUBSUB] → Routing to ZIP job handler`);
        
        // Extract prenom from message data
        const prenom = messageData.prenom;
        
        if (!prenom) {
          console.error(`[PUBSUB] ✗ Message does not contain prenom - skipping processing`);
          message.ack();
          return;
        }
        
        await processZipJob(messageData.tags, prenom);
      } else {
        console.log(`[PUBSUB] ⚠ Message does not contain tags or is not a zip request - skipping processing`);
      }
      
      // "Ack" (acknowledge receipt of) the message
      message.ack();
      console.log(`[PUBSUB] ✓ Message ${message.id} acknowledged`);
      console.log(`[PUBSUB] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    } catch (error) {
      console.error(`[PUBSUB] ✗ Error processing message ${message.id}:`, error.message);
      // Nack the message to requeue it
      message.nack();
      console.log(`[PUBSUB] ⟲ Message ${message.id} requeued for retry`);
    }
  };

  // Handle errors
  const errorHandler = (error) => {
    console.error('[PUBSUB] ✗ Error receiving message:', error.message);
  };

  // Listen for new messages continuously
  subscription.on('message', messageHandler);
  subscription.on('error', errorHandler);

  console.log(`\n[PUBSUB] 👂 Listening for messages on subscription: ${subscriptionNameOrId}`);
  console.log(`[PUBSUB] 📡 Topic: ${topicName}`);
  console.log(`[PUBSUB] 🔄 Ready to process zip requests...\n`);
}

// Function to start listening with environment variables
function startListener() {
  const subscriptionName = process.env.SUBSCRIPTION_NAME;
  
  if (!subscriptionName) {
    console.error('[PUBSUB] ✗ SUBSCRIPTION_NAME not set in environment variables');
    return;
  }
  
  console.log('[PUBSUB] Starting message listener...');
  listenForMessages(subscriptionName).catch(console.error);
}

// Export for use in server.js
module.exports = {
  listenForMessages,
  startListener,
  zipFilesStore,
  storage
};

// Allow direct execution for testing
if (require.main === module) {
  startListener();
}