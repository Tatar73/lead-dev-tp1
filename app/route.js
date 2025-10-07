const formValidator = require('./form_validator');
const photoModel = require('./photo_model');
const { sendMessage } = require('./pubsub');
const { zipFilesStore, storage } = require('./listenForMessage');
const moment = require('moment');

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
  app.post('/zip', async (req, res) => {
    const tags = req.query.tags;

    // validate tags parameter
    if (!tags) {
      return res.status(400).send({ error: 'Tags parameter is required' });
    }

    console.log(`Received request to zip photos for tags: ${tags}`);
    
    try {
      const message = {
        tags: tags,
        timestamp: new Date().toISOString(),
        requestType: 'zip'
      };
      
      await sendMessage(message);

      // Return success response - the worker will process the zip
      return res.status(202).json({ 
        message: 'Zip job queued successfully',
        tags: tags,
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
}

module.exports = route;

