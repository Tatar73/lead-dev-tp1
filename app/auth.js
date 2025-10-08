'use strict';

const { JWT } = require('google-auth-library');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

/**
 * Load and validate service account credentials
 * @returns {JWT} Authenticated JWT client
 */
function getAuthClient() {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  
  if (!credentialsPath) {
    console.error('❌ GOOGLE_APPLICATION_CREDENTIALS environment variable is not set');
    return;
  }

  // Read and parse the JSON key file
  const credentialsJson = fs.readFileSync(credentialsPath, 'utf8');
  const keys = JSON.parse(credentialsJson);

  // Validate that this is a service account key
  if (keys.type !== 'service_account') {
    console.error('Invalid credentials: type must be "service_account"');
    return;
  }

  // Create JWT client using the new constructor method (not deprecated)
  const authClient = new JWT({
    email: keys.client_email,
    key: keys.private_key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });

  return authClient;
}

module.exports = {
  getAuthClient
};
