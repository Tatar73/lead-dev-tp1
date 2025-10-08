'use strict';

// Imports the Google Cloud client library
const {PubSub} = require('@google-cloud/pubsub');
const {Storage} = require('@google-cloud/storage');
const dotenv = require('dotenv');
const { getAuthClient } = require('./auth');
const photoModel = require('./photo_model');
const request = require('request');

dotenv.config();

// In-memory store for zip files (tags -> filename mapping)
// In production, use a database like Redis or Firestore
const zipFilesStore = new Map();


// Get authenticated client
const authClient = getAuthClient();

// Creates a client; cache this for further use
const pubSubClient = new PubSub({
  projectId: process.env.PROJECT_ID,
  authClient
});

// Create Storage client with proper authentication
const storage = new Storage({
  projectId: process.env.PROJECT_ID,
});

// Function to process zip job
async function processZipJob(tags) {
  console.log(`\nStarting zip job for tags: ${tags}`);
  
  try {
    // 1. Get photos from Flickr
    const photos = await photoModel.getFlickrPhotos(tags);
    
    if (!photos || photos.length === 0) {
      throw new Error('No photos found for the given tags');
    }
    
    // 2. Take only first 10 photos
    const photosToZip = photos.slice(0, 10);
    console.log(`Found ${photos.length} photos, zipping first ${photosToZip.length}`);
    
    // 3. Create zip in memory
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
    await addFilesToZip(zip, photosToZip);
    
    // Wait for zip to complete
    const zipBuffer = await zipPromise;
    console.log(`Zip created, size: ${zipBuffer.length} bytes`);
    
    // 5. Upload to Google Cloud Storage
    const filename = `photos-${tags}-${Date.now()}.zip`;
    const bucketName = process.env.STORAGE_BUCKET;
    if (!bucketName) {
      throw new Error('STORAGE_BUCKET environment variable is not set');
    }
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filename);
    
    const stream = file.createWriteStream({
      metadata: {
        contentType: 'application/zip',
        cacheControl: 'private'
      },
      resumable: false
    });
    
    await new Promise((resolve, reject) => {
      stream.on('error', (err) => {
        console.error('Upload error:', err);
        reject(err);
      });
      
      stream.on('finish', () => {
        console.log('Upload finished');
        resolve('Ok');
      });
      
      stream.end(zipBuffer);
    });
    
    // 6. Generate signed URL for download (valid for 7 days)
    const [signedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    
    console.log(`Zip uploaded successfully: ${signedUrl}`);
    
    // Store the filename for this tags combination
    zipFilesStore.set(tags, filename);
    console.log(`Stored filename "${filename}" for tags "${tags}"`);

    return signedUrl;
    
  } catch (error) {
    console.error(`Error processing zip job for tags "${tags}":`, error);
    
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
        resolve();
        return;
      }
      
      const photo = photos[index];
      const filename = `photo-${index + 1}-${photo.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50)}.jpg`;
      
      console.log(`  Adding file ${index + 1}/${photos.length}: ${filename}`);
      
      const stream = request(photo.media.m);
      
      zip.entry(stream, { name: filename }, (err) => {
        if (err) {
          console.error(`Error adding file ${filename}:`, err);
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
    console.log(`Subscription ${subscriptionNameOrId} does not exist. Creating it...`);
    [subscription] = await topic.createSubscription(subscriptionNameOrId);
    console.log(`Subscription ${subscriptionNameOrId} created.`);
  } else {
    console.log(`Listening on existing subscription: ${subscriptionNameOrId}`);
  }

  // Create an event handler to handle messages
  const messageHandler = async (message) => {
    console.log(`\nReceived message ${message.id}:`);
    console.log(`\tData: ${message.data.toString()}`);
    console.log(`\tAttributes:`, message.attributes);
    
    try {
      const dataString = message.data.toString();
      let messageData;
      
      // Try to parse as JSON, if it fails, treat as plain text
      try {
        messageData = JSON.parse(dataString);
        console.log(`\tParsed JSON data:`, messageData);
      } catch (parseError) {
        messageData = { text: dataString };
        console.log(`\tPlain text message (not JSON)`);
      }
      
      // Process zip job if tags are provided
      if (messageData.tags && messageData.requestType === 'zip') {
        console.log(`\nProcessing zip job for tags: ${messageData.tags}`);
        await processZipJob(messageData.tags);
      } else {
        console.log(`\tMessage does not contain tags or is not a zip request`);
      }
      
      // "Ack" (acknowledge receipt of) the message
      message.ack();
      console.log(`Message ${message.id} acknowledged`);
    } catch (error) {
      console.error(`Error processing message ${message.id}:`, error);
      // Nack the message to requeue it
      message.nack();
    }
  };

  // Handle errors
  const errorHandler = (error) => {
    console.error('Error receiving message:', error);
  };

  // Listen for new messages continuously
  subscription.on('message', messageHandler);
  subscription.on('error', errorHandler);

  console.log(`Listening for messages on subscription: ${subscriptionNameOrId}`);
}

// Function to start listening with environment variables
function startListener() {
  const subscriptionName = process.env.SUBSCRIPTION_NAME;
  
  if (!subscriptionName) {
    console.error('SUBSCRIPTION_NAME not set in environment variables');
    return;
  }
  
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