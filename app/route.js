const formValidator = require('./form_validator');
const photoModel = require('./photo_model');
const { sendMessage } = require('./pubsub');
const { zipFilesStore, storage } = require('./listenForMessage');
const { getZipDataByPrenom } = require('./firebase');
const moment = require('moment');
const { rateLimiter } = require('./rate_limiter');

function route(app) {
  app.get('/', async (req, res) => {
    const tags = req.query.tags;
    const tagmode = req.query.tagmode;

    const ejsLocalVariables = {
      tagsParameter: tags || '',
      tagmodeParameter: tagmode || '',
      photos: [],
      searchResults: false,
      invalidParameters: false,
      downloadLink: null
    };

    // if no input params are passed in then render the view with out querying the api
    if (!tags && !tagmode) {
      return res.render('index', ejsLocalVariables);
    }

    // validate query parameters
    if (!formValidator.hasValidFlickrAPIParams(tags, tagmode)) {
      ejsLocalVariables.invalidParameters = true;
      return res.render('index', ejsLocalVariables);
    }

    // Check if a zip file already exists for these tags
    const filename = zipFilesStore.get(tags);
    if (filename) {
      try {
        // Generate a signed URL for downloading the zip
        const options = {
          action: 'read',
          expires: moment().add(2, 'days').unix() * 1000
        };
        
        const signedUrls = await storage
          .bucket(process.env.STORAGE_BUCKET)
          .file(filename)
          .getSignedUrl(options);
        
        ejsLocalVariables.downloadLink = signedUrls[0];
        console.log(`✅ Generated download link for tags "${tags}": ${ejsLocalVariables.downloadLink}`);
      } catch (error) {
        console.error('Error generating signed URL:', error);
      }
    }

    // get photos from flickr public feed api
    return photoModel
      .getFlickrPhotos(tags, tagmode)
      .then(photos => {
        ejsLocalVariables.photos = photos;
        ejsLocalVariables.searchResults = true;
        return res.render('index', ejsLocalVariables);
      })
      .catch(error => {
        console.error('Error fetching Flickr photos:', error);
        return res.status(500).send({ error });
      });
  });
  
  // Apply rate limiter only to /zip endpoint
  app.post('/zip', rateLimiter, async (req, res) => {
    const tags = req.query.tags;
    const prenom = req.query.prenom;

    // validate tags parameter
    if (!tags) {
      return res.status(400).send({ error: 'Tags parameter is required' });
    }

    // validate prenom parameter
    if (!prenom) {
      return res.status(401).send({ error: 'Authentication required: prenom parameter is missing' });
    }

    console.log(`Received request to zip photos for tags: ${tags}, user: ${prenom}`);
    
    try {
      const message = {
        tags: tags,
        prenom: prenom,
        timestamp: new Date().toISOString(),
        requestType: 'zip'
      };
      
      await sendMessage(message);

      // Return success response - the worker will process the zip
      return res.status(202).json({ 
        message: 'Zip job queued successfully',
        tags: tags,
        prenom: prenom,
        checkStatusAt: `/job-status/${tags}`
      });

    } catch (error) {
      console.error('Error creating zip:', error);
      return res.status(500).send({ 
        error: 'Failed to queue zip job',
        details: error.message
      });
    }
  });

  // API endpoint to get existing ZIPs from Firebase (secure)
  app.get('/api/zips', async (req, res) => {
    try {
      const prenom = req.query.prenom;
      
      if (!prenom) {
        console.error('[API] Prenom parameter is required');
        return res.status(400).json({ 
          success: false, 
          error: 'Prenom parameter is required' 
        });
      }

      console.log(`[API] Fetching ZIPs for user: ${prenom}`);
      
      // Fetch data from Firebase (credentials are secure on server)
      const zipData = await getZipDataByPrenom(prenom);
      
      if (zipData) {
        console.log(`[API] ✓ Found ZIP data for ${prenom}`);
        return res.json({ 
          success: true, 
          zips: zipData 
        });
      } else {
        console.log(`[API] No ZIP data found for ${prenom}`);
        return res.json({ 
          success: true, 
          zips: null 
        });
      }
      
    } catch (error) {
      console.error('[API] ✗ Error fetching ZIPs:', error.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch ZIP files' 
      });
    }
  });

  // API endpoint to get Firebase config (only public config, no secrets!)
  app.get('/api/firebase-config', (req, res) => {
    try {
      // Only send public Firebase config (safe to expose to client)
      const firebaseConfig = {
        apiKey: process.env.API_KEY,
        authDomain: process.env.AUTH_DOMAIN,
        databaseURL: process.env.DATABASE_URL,
        projectId: process.env.PROJECT_ID,
        storageBucket: process.env.STORAGE_BUCKET,
        messagingSenderId: process.env.MESSAGING_SENDER_ID,
        appId: process.env.APP_ID
      };

      console.log('[API] Firebase config requested');
      
      return res.json({ 
        success: true, 
        firebaseConfig 
      });
      
    } catch (error) {
      console.error('[API] ✗ Error providing Firebase config:', error.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to load configuration' 
      });
    }
  });
}

module.exports = route;

