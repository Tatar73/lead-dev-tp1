'use strict';

const admin = require('firebase-admin');
const { initializeApp } = require('firebase/app');
const { getAuth } = require('firebase/auth');
const dotenv = require('dotenv');
const fs = require('fs');

dotenv.config();

// ========================================
// Firebase Admin SDK (Server-side)
// Pour sauvegarder les données dans Realtime Database
// ========================================

// Initialize Firebase Admin SDK with service account
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!credentialsPath) {
  console.error('❌ GOOGLE_APPLICATION_CREDENTIALS environment variable is not set');
}

// Read and parse the JSON key file
const serviceAccount = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

// Initialize Firebase Admin
const firebaseAdminApp = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.DATABASE_URL
});

// Get a reference to the database service
const db = admin.database();

// ========================================
// Firebase Web SDK (Client-side)
// Pour l'authentification utilisateur
// ========================================

// Configuration Firebase depuis les variables d'environnement
const firebaseConfig = {
  apiKey: process.env.API_KEY,
  authDomain: process.env.AUTH_DOMAIN,
  databaseURL: process.env.DATABASE_URL,
  projectId: process.env.PROJECT_ID,
  storageBucket: process.env.STORAGE_BUCKET,
  messagingSenderId: process.env.MESSAGING_SENDER_ID,
  appId: process.env.APP_ID
};

// Initialize Firebase Web SDK
const firebaseWebApp = initializeApp(firebaseConfig, 'web');
const auth = getAuth(firebaseWebApp);

async function saveZipDataToFirebase(prenom, filename, signedUrl, storagePath, photoLinks = []) {
  try {
    // Get current timestamp
    const now = new Date();
    const zipTimestamp = now.toISOString();
    
    // Extract only the time (HH-MM-SS-mmm) for the Firebase path
    // Format: 12-42-32-003 from 2025-10-08T12:42:32.003Z
    const timeOnly = zipTimestamp
      .split('T')[1]           // Get the time part after T
      .replace(/:/g, '-')      // Replace : with -
      .replace(/\./g, '-')     // Replace . with -
      .replace('Z', '');       // Remove Z
    
    // Remove .zip extension from filename for Firebase path (. is not allowed)
    // photos-california-xxx.zip -> photos-california-xxx
    const filenameWithoutExt = filename.replace('.zip', '');
    
    // Create the data object
    const zipData = {
      filename: filename,  // Keep the full filename with .zip in the data
      storagePath: storagePath,
      signedUrl: signedUrl,
      photoLinks: photoLinks,
      createdAt: zipTimestamp,  // Keep full ISO format in the data
      photoCount: photoLinks.length
    };
    
    // Save to Firebase at path: /prenom/heure/filename (without .zip extension)
    const ref = db.ref(`${prenom}/${timeOnly}/${filenameWithoutExt}`);
    await ref.set(zipData);
    
    console.log(`[FIREBASE] ✓ Data saved at: /${prenom}/${timeOnly}/${filenameWithoutExt}`);
    
    return zipData;
  } catch (error) {
    console.error('[FIREBASE] ✗ Error saving to Firebase:', error.message);
    throw error;
  }
}

async function getZipDataByPrenom(prenom) {
  try {
    console.log(`[FIREBASE] Reading data for: ${prenom}`);
    const ref = db.ref(prenom);
    const snapshot = await ref.once('value');
    
    if (snapshot.exists()) {
      console.log(`[FIREBASE] ✓ Data found for ${prenom}`);
      return snapshot.val();
    } else {
      console.log(`[FIREBASE] No data found for ${prenom}`);
      return null;
    }
  } catch (error) {
    console.error('[FIREBASE] ✗ Error reading from Firebase:', error.message);
    throw error;
  }
}

module.exports = { 
  firebaseAdminApp,
  firebaseWebApp,
  auth,
  db,
  saveZipDataToFirebase,
  getZipDataByPrenom
};
