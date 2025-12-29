const express = require('express');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const dotenv = require('dotenv');
const excel = require('exceljs');
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const uri = process.env.MONGO_URI;

let db;
let gridFSBucket;

// Allowed image MIME types
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg', 
  'image/png',
  'image/gif',
  'image/webp'
];

// Allowed file extensions
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

// Configure multer for file uploads - using memory storage for GridFS
const storage = multer.memoryStorage();

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per file
    files: 10, // Max 10 files per request
    fieldSize: 10 * 1024 * 1024, // 10MB for other form fields
    fields: 50, // Max 50 non-file fields
    parts: 60 // Max 60 parts total (files + fields)
  },
  fileFilter: function (req, file, cb) {
    // 1. Check MIME type (first line of defense)
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype.toLowerCase())) {
      return cb(new Error(`Invalid file type. Only ${ALLOWED_EXTENSIONS.join(', ')} images are allowed.`), false);
    }
    
    // 2. Check file extension (second line of defense)
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error(`Invalid file extension. Only ${ALLOWED_EXTENSIONS.join(', ')} files are allowed.`), false);
    }
    
    // 3. Validate filename (prevent path traversal)
    const filename = path.basename(file.originalname);
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return cb(new Error('Invalid filename. Path traversal not allowed.'), false);
    }
    
    cb(null, true);
  }
});

// Magic number validation function (validates actual file content)
function validateImageMagicNumber(buffer, mimetype) {
  if (!buffer || buffer.length < 4) return false;
  
  const firstBytes = buffer.slice(0, 4);
  const hex = Array.from(firstBytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  
  // JPEG: FF D8 FF
  if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') {
    return hex.startsWith('FFD8FF');
  }
  
  // PNG: 89 50 4E 47
  if (mimetype === 'image/png') {
    return hex === '89504E47';
  }
  
  // GIF: 47 49 46 38
  if (mimetype === 'image/gif') {
    return hex.startsWith('47494638');
  }
  
  // WebP: Check for RIFF...WEBP
  if (mimetype === 'image/webp') {
    if (buffer.length < 12) return false;
    return buffer.slice(0, 4).toString() === 'RIFF' &&
           buffer.slice(8, 12).toString() === 'WEBP';
  }
  
  return false;
}

// Middleware to validate uploaded files after multer processing
function validateUploadedFiles(req, res, next) {
  if (!req.files) return next();
  
  const errors = [];
  
  Object.keys(req.files).forEach(fieldName => {
    if (req.files[fieldName] && req.files[fieldName][0]) {
      const file = req.files[fieldName][0];
      
      // Validate magic number (actual file content)
      if (!validateImageMagicNumber(file.buffer, file.mimetype)) {
        errors.push(`File ${file.originalname} does not match its declared type. Possible file spoofing.`);
      }
      
      // Additional size check (defense in depth)
      if (file.size > 5 * 1024 * 1024) {
        errors.push(`File ${file.originalname} exceeds 5MB limit.`);
      }
    }
  });
  
  if (errors.length > 0) {
    console.error('File validation failed:', errors);
    return res.status(400).json({ 
      error: 'File validation failed', 
      details: errors 
    });
  }
  
  next();
}

// Rate limiting for upload endpoints
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Max 10 upload requests per window per IP
  message: 'Too many upload requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false, // Count all requests, even successful ones
});

// User and Roles routes
const userRoutes = require('./routes/userRoutes');
const authRoutes = require('./routes/authRoutes');
// Middleware setup - order is important
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Register user/roles API before static file serving and error handlers
app.use('/api/users', userRoutes);
app.use('/api/auth', authRoutes);

// API routes should come before static file serving
app.use('/api', (req, res, next) => {
  res.setHeader('Content-Type', 'application/json');
  next();
});

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Helper function to sync tag counters with actual saved tags
async function syncTagCounters() {
  try {
    const campaigns = db.collection('campaigns');
    const tagCounters = db.collection('tagCounters');
    
    // Get all campaigns and extract all tag numbers
    const allCampaigns = await campaigns.find({}).toArray();
    const tagNumbersByPrefix = {};
    
    // Collect all tag numbers by prefix
    allCampaigns.forEach(campaign => {
      if (campaign.channels && Array.isArray(campaign.channels)) {
        campaign.channels.forEach(channel => {
          if (channel.tagNumber && channel.tagNumber.trim() !== '') {
            const tagNumber = channel.tagNumber.trim();
            
            // Validate tag number format: must be at least 3 characters (2-char prefix + at least 1 digit)
            if (tagNumber.length < 3) {
              console.warn(`Invalid tag number format (too short): "${tagNumber}" in campaign ${campaign.campaignId || 'unknown'}`);
              return;
            }
            
            const prefix = tagNumber.substring(0, 2);
            const numberPart = parseInt(tagNumber.substring(2));
            
            // Validate that the number part is a valid integer
            if (isNaN(numberPart) || numberPart < 0) {
              console.warn(`Invalid tag number format (non-numeric): "${tagNumber}" in campaign ${campaign.campaignId || 'unknown'}`);
              return;
            }
            
            if (!tagNumbersByPrefix[prefix]) {
              tagNumbersByPrefix[prefix] = [];
            }
            tagNumbersByPrefix[prefix].push(numberPart);
          }
        });
      }
    });
    
    // Update counters based on actual saved tags
    for (const [prefix, numbers] of Object.entries(tagNumbersByPrefix)) {
      if (numbers.length > 0) {
        // Filter out any NaN values (shouldn't happen with validation above, but just in case)
        const validNumbers = numbers.filter(n => !isNaN(n) && n >= 0);
        
        if (validNumbers.length > 0) {
          const maxNumber = Math.max(...validNumbers);
          
          // Update or create counter
          await tagCounters.updateOne(
            { prefix: prefix },
            { $set: { lastNumber: maxNumber } },
            { upsert: true }
          );
          
          console.log(`Synced counter for ${prefix} to ${maxNumber}`);
        } else {
          console.warn(`No valid numbers found for prefix ${prefix}, skipping sync`);
        }
      }
    }
    
    // For prefixes with no saved tags, keep the existing counter (don't reset to 0)
    // This preserves the highest number ever used, even if all tags are deleted
    const existingCounters = await tagCounters.find({}).toArray();
    for (const counter of existingCounters) {
      if (!tagNumbersByPrefix[counter.prefix]) {
        // Don't reset to 0 - keep the existing counter value
        // This ensures gaps are preserved and numbers are never reused
        console.log(`Keeping counter for ${counter.prefix} at ${counter.lastNumber} (no current saved tags, but preserving history)`);
      }
    }
  } catch (err) {
    console.error('Error syncing tag counters:', err);
  }
}

// POST: Manually sync tag counters with actual saved tags
app.post('/api/tags/sync', async (req, res) => {
  try {
    await syncTagCounters();
    res.json({ message: 'Tag counters synced successfully' });
  } catch (err) {
    console.error('Error syncing tag counters:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET: Debug endpoint to check campaign data structure
app.get('/api/debug/campaigns', async (req, res) => {
  try {
    console.log('Debug campaigns endpoint called');
    const campaigns = db.collection('campaigns');
    const allCampaigns = await campaigns.find({}).toArray();
    
    console.log(`Found ${allCampaigns.length} campaigns`);
    
    // Show simplified campaign data
    const debugData = allCampaigns.map(campaign => ({
      campaignId: campaign.campaignId,
      name: campaign.name,
      channelsCount: campaign.channels?.length || 0,
      channels: campaign.channels?.map(channel => ({
        type: channel.type,
        platform: channel.platform,
        impressions: channel.impressions,
        hasImpressions: channel.hasOwnProperty('impressions')
      })) || []
    }));
    
    res.json(debugData);
  } catch (err) {
    console.error('Error getting debug campaigns:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST: Create or update campaign with multiple image uploads
app.post('/api/campaigns', uploadLimiter, upload.fields([
  { name: 'campaignImage0', maxCount: 1 },
  { name: 'campaignImage1', maxCount: 1 },
  { name: 'campaignImage2', maxCount: 1 },
  { name: 'campaignImage3', maxCount: 1 },
  { name: 'campaignImage4', maxCount: 1 },
  { name: 'campaignImage5', maxCount: 1 },
  { name: 'campaignImage6', maxCount: 1 },
  { name: 'campaignImage7', maxCount: 1 },
  { name: 'campaignImage8', maxCount: 1 },
  { name: 'campaignImage9', maxCount: 1 }
]), validateUploadedFiles, async (req, res) => {
  try {
    console.log('=== REQUEST RECEIVED ===');
    console.log('Request method:', req.method);
    console.log('Request URL:', req.url);
    console.log('Content-Type:', req.headers['content-type']);
    console.log('req.body keys:', Object.keys(req.body || {}));
    console.log('req.files exists:', !!req.files);
    console.log('req.files keys:', req.files ? Object.keys(req.files) : 'N/A');
    
    // Parse campaign data from form
    let campaignData;
    try {
      campaignData = JSON.parse(req.body.campaignData);
    } catch (parseError) {
      console.error('✗ Failed to parse campaignData:', parseError);
      return res.status(400).json({ error: 'Invalid campaign data format' });
    }
    
    console.log('=== CAMPAIGN SUBMISSION DEBUG ===');
    console.log('Campaign data received:', JSON.stringify(campaignData, null, 2));
    
    // Handle multiple image uploads - save to GridFS
    console.log('=== IMAGE UPLOAD DEBUG ===');
    console.log('req.files exists:', !!req.files);
    console.log('req.files keys:', req.files ? Object.keys(req.files) : 'N/A');
    
    // Track uploaded filenames for cleanup on failure
    const uploadedFilenames = [];
    
    if (req.files) {
      const images = [];
      const uploadPromises = [];
      
      Object.keys(req.files).forEach(fieldName => {
        if (req.files[fieldName] && req.files[fieldName][0]) {
          const file = req.files[fieldName][0];
          console.log(`Processing file from field ${fieldName}: ${file.originalname} (${file.size} bytes, ${file.mimetype})`);
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
          const filename = `campaign-${uniqueSuffix}${path.extname(file.originalname)}`;
          uploadedFilenames.push(filename); // Track for cleanup
          
          // Upload to GridFS
          const uploadPromise = new Promise((resolve, reject) => {
            const uploadStream = gridFSBucket.openUploadStream(filename, {
              contentType: file.mimetype,
              metadata: {
                originalName: file.originalname,
                uploadedAt: new Date()
              }
            });
            
            uploadStream.on('finish', () => {
              const imagePath = `/api/images/${filename}`;
              images.push(imagePath);
              console.log(`✓ Image uploaded to GridFS: ${filename} -> ${imagePath}`);
              resolve();
            });
            
            uploadStream.on('error', (error) => {
              console.error(`✗ Error uploading image ${filename}:`, error);
              // Remove from tracking array on error
              const index = uploadedFilenames.indexOf(filename);
              if (index > -1) {
                uploadedFilenames.splice(index, 1);
              }
              reject(error);
            });
            
            // Write buffer to GridFS
            uploadStream.end(file.buffer);
          });
          
          uploadPromises.push(uploadPromise);
        } else {
          console.log(`Field ${fieldName}: No file or empty array`);
        }
      });
      
      // Wait for all images to upload
      if (uploadPromises.length > 0) {
        console.log(`Waiting for ${uploadPromises.length} image(s) to upload...`);
        await Promise.all(uploadPromises);
        if (images.length > 0) {
          campaignData.images = images;
          console.log('✓ Images array set in campaignData:', images);
          console.log('✓ campaignData.images after assignment:', campaignData.images);
        } else {
          console.log('⚠ No images were successfully uploaded');
        }
      } else {
        console.log('⚠ No image upload promises created');
      }
    } else {
      console.log('⚠ req.files is null/undefined - no images to process');
    }
    
    console.log('=== FINAL campaignData.images before save ===');
    console.log('campaignData.images:', campaignData.images);
    console.log('campaignData.images type:', typeof campaignData.images);
    console.log('campaignData.images isArray:', Array.isArray(campaignData.images));
    
    if (campaignData.channels && Array.isArray(campaignData.channels)) {
      console.log('Channels found:', campaignData.channels.length);
      campaignData.channels.forEach((channel, index) => {
        console.log(`Channel ${index + 1}:`, {
          type: channel.type,
          platform: channel.platform,
          impressions: channel.impressions,
          hasImpressions: channel.hasOwnProperty('impressions')
        });
      });
    } else {
      console.log('No channels found in campaign data');
    }
    
    // Validate tag numbers for uniqueness
    if (campaignData.channels && Array.isArray(campaignData.channels)) {
      // Collect all tagNumbers, filtering out empty, null, undefined values
      const tagNumbers = campaignData.channels
        .map(channel => channel.tagNumber)
        .filter(tag => tag !== null && tag !== undefined && typeof tag === 'string' && tag.trim() !== '')
        .map(tag => tag.trim()); // Normalize by trimming
      
      console.log(`Create: Total channels: ${campaignData.channels.length}, Valid tagNumbers: ${tagNumbers.length}`);
      console.log(`Create: TagNumbers found: ${JSON.stringify(tagNumbers)}`);
      
      if (tagNumbers.length > 0) {
        // Check for duplicates within the same campaign
        const uniqueTags = new Set(tagNumbers);
        if (uniqueTags.size !== tagNumbers.length) {
          // Find tags that appear multiple times with their counts
          const tagCounts = {};
          tagNumbers.forEach(tag => {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          });
          
          // Only include tags that appear more than once
          const actualDuplicates = Object.entries(tagCounts)
            .filter(([tag, count]) => count > 1)
            .map(([tag, count]) => `${tag} (appears ${count} times)`);
          
          console.log(`Create: Duplicate tags within campaign: ${JSON.stringify(actualDuplicates)}`);
          console.log(`Create: Full tagNumbers array: ${JSON.stringify(tagNumbers)}`);
          console.log(`Create: Tag counts: ${JSON.stringify(tagCounts)}`);
          
          if (actualDuplicates.length > 0) {
            return res.status(400).json({ 
              error: `Duplicate reference codes found within the campaign: ${actualDuplicates.join(', ')}. Each reference code must be unique.` 
            });
          }
        }
        
        // Check for duplicates across all existing campaigns (excluding current campaign if updating)
        const campaigns = db.collection('campaigns');
        const existingCampaigns = await campaigns.find({}).toArray();
        const existingTags = new Set();
        
        console.log(`Create: Checking tag uniqueness for new campaign`);
        console.log(`Create: New campaign has tags: ${tagNumbers.join(', ')}`);
        
        existingCampaigns.forEach(campaign => {
          // For CREATE: include all campaigns (campaignData.campaignId is undefined)
          if (campaign.channels && Array.isArray(campaign.channels)) {
            campaign.channels.forEach(channel => {
              if (channel.tagNumber) {
                existingTags.add(channel.tagNumber);
              }
            });
          }
        });
        
        console.log(`Create: Found existing tags from other campaigns: ${Array.from(existingTags).join(', ')}`);
        
        const duplicateTags = tagNumbers.filter(tag => existingTags.has(tag));
        if (duplicateTags.length > 0) {
          console.log(`Create: Duplicate tags found: ${duplicateTags.join(', ')}`);
          return res.status(400).json({ 
            error: `Reference code(s) already exist: ${duplicateTags.join(', ')}. Each reference code must be globally unique.` 
          });
        }
        
        console.log(`Create: All tags are unique, proceeding with creation`);
      }
    }
    
    // Generate campaignId if not provided
    if (!campaignData.campaignId) {
      campaignData.campaignId = await getNextCampaignId();
    }
    
    console.log('=== SAVING CAMPAIGN TO DATABASE ===');
    console.log('campaignId:', campaignData.campaignId);
    console.log('campaignData.images before save:', campaignData.images);
    console.log('campaignData keys:', Object.keys(campaignData));
    
    const campaigns = db.collection('campaigns');
    
    try {
      const result = await campaigns.updateOne(
        { campaignId: campaignData.campaignId },
        { $set: campaignData },
        { upsert: true }
      );
      
      console.log('=== DATABASE SAVE RESULT ===');
      console.log('Matched:', result.matchedCount);
      console.log('Modified:', result.modifiedCount);
      console.log('Upserted:', result.upsertedCount);
      
      // Verify the saved document
      const savedCampaign = await campaigns.findOne({ campaignId: campaignData.campaignId });
      console.log('=== VERIFIED SAVED CAMPAIGN ===');
      console.log('savedCampaign.images:', savedCampaign?.images);
      console.log('savedCampaign.images type:', typeof savedCampaign?.images);
      console.log('savedCampaign.images isArray:', Array.isArray(savedCampaign?.images));

      // Sync tag counters after save to ensure consistency
      await syncTagCounters();
      
      res.status(200).json({ message: 'Campaign saved successfully', campaignId: campaignData.campaignId });
    } catch (dbErr) {
      // Handle duplicate key errors (MongoDB error code 11000)
      if (dbErr.code === 11000 || dbErr.codeName === 'DuplicateKey') {
        console.error('Duplicate key error during campaign creation:', dbErr);
        const duplicateField = dbErr.keyPattern ? Object.keys(dbErr.keyPattern)[0] : 'campaignId';
        return res.status(409).json({ 
          error: `Duplicate ${duplicateField} detected. This may be due to concurrent requests. Please refresh and try again.`,
          duplicateField: duplicateField,
          details: 'A campaign with this identifier already exists or was just created by another request.'
        });
      }
      // Re-throw other database errors to be caught by outer catch
      throw dbErr;
    }
  } catch (err) {
    console.error('Error saving campaign:', err);
    
    // Cleanup: Delete uploaded images if campaign save failed
    if (uploadedFilenames && uploadedFilenames.length > 0) {
      console.log(`⚠ Campaign creation failed. Cleaning up ${uploadedFilenames.length} uploaded image(s)...`);
      
      for (const filename of uploadedFilenames) {
        try {
          // Find the file in GridFS by filename
          const filesCollection = db.collection('images.files');
          const file = await filesCollection.findOne({ filename: filename });
          if (file) {
            await gridFSBucket.delete(file._id);
            console.log(`✓ Cleaned up orphaned image: ${filename} (ID: ${file._id})`);
          } else {
            console.log(`⚠ Image not found in GridFS for cleanup: ${filename}`);
          }
        } catch (cleanupError) {
          console.error(`✗ Error cleaning up image ${filename}:`, cleanupError);
          // Continue cleanup even if one fails
        }
      }
    }
    
    // If it's already a 409 response, don't override it
    if (err.status === 409) {
      throw err;
    }
    
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// PUT: Update campaign
// PUT: Update campaign with multiple image uploads
app.put('/api/campaigns/:campaignId', uploadLimiter, upload.fields([
  { name: 'campaignImage0', maxCount: 1 },
  { name: 'campaignImage1', maxCount: 1 },
  { name: 'campaignImage2', maxCount: 1 },
  { name: 'campaignImage3', maxCount: 1 },
  { name: 'campaignImage4', maxCount: 1 },
  { name: 'campaignImage5', maxCount: 1 },
  { name: 'campaignImage6', maxCount: 1 },
  { name: 'campaignImage7', maxCount: 1 },
  { name: 'campaignImage8', maxCount: 1 },
  { name: 'campaignImage9', maxCount: 1 }
]), validateUploadedFiles, async (req, res) => {
  try {
    const campaignId = req.params.campaignId;
    
    console.log('=== UPDATE REQUEST RECEIVED ===');
    console.log('Request method:', req.method);
    console.log('Request URL:', req.url);
    console.log('Content-Type:', req.headers['content-type']);
    console.log('req.body keys:', Object.keys(req.body || {}));
    console.log('req.files exists:', !!req.files);
    console.log('req.files keys:', req.files ? Object.keys(req.files) : 'N/A');
    
    // Validate ObjectId format
    if (!ObjectId.isValid(campaignId)) {
      console.error(`Invalid ObjectId format: ${campaignId}`);
      return res.status(400).json({ error: 'Invalid campaign ID format' });
    }
    
    // Parse campaign data from FormData
    let campaignData;
    try {
      // If it's FormData, campaignData will be in req.body.campaignData as a JSON string
      if (req.body.campaignData) {
        campaignData = JSON.parse(req.body.campaignData);
      } else if (typeof req.body === 'string') {
        campaignData = JSON.parse(req.body);
      } else {
        campaignData = req.body;
      }
    } catch (parseError) {
      console.error('Error parsing campaign data:', parseError);
      return res.status(400).json({ error: 'Invalid campaign data format' });
    }
    
    if (!campaignData || Object.keys(campaignData).length === 0) {
      console.error('No campaign data provided in request body');
      return res.status(400).json({ error: 'No campaign data provided' });
    }
    
    console.log(`PUT /api/campaigns/${campaignId}: Received campaign data with ${campaignData.channels?.length || 0} channels`);
    console.log('=== CAMPAIGN DATA RECEIVED ===');
    console.log('campaignData.imagesToRemove:', campaignData.imagesToRemove);
    console.log('Type:', typeof campaignData.imagesToRemove);
    console.log('Is array?', Array.isArray(campaignData.imagesToRemove));
    if (campaignData.imagesToRemove) {
      console.log('Length:', campaignData.imagesToRemove.length);
      console.log('Contents:', JSON.stringify(campaignData.imagesToRemove));
    }
    
    // Get existing campaign to preserve existing images if no new images are uploaded
    const campaigns = db.collection('campaigns');
    let objectId;
    try {
      objectId = new ObjectId(campaignId);
    } catch (objectIdError) {
      console.error(`Error creating ObjectId from ${campaignId}:`, objectIdError);
      return res.status(400).json({ error: 'Invalid campaign ID format' });
    }
    
    const existingCampaign = await campaigns.findOne({ _id: objectId });
    if (!existingCampaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    // Handle multiple image uploads - save to GridFS
    console.log('=== UPDATE IMAGE UPLOAD DEBUG ===');
    console.log('req.files exists:', !!req.files);
    console.log('req.files keys:', req.files ? Object.keys(req.files) : 'N/A');
    console.log('Existing campaign images:', existingCampaign.images);
    
    // Track newly uploaded filenames for cleanup on failure
    const uploadedFilenames = [];
    
    if (req.files) {
      const newImages = [];
      const uploadPromises = [];
      
      Object.keys(req.files).forEach(fieldName => {
        if (req.files[fieldName] && req.files[fieldName][0]) {
          const file = req.files[fieldName][0];
          console.log(`Processing file from field ${fieldName}: ${file.originalname} (${file.size} bytes, ${file.mimetype})`);
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
          const filename = `campaign-${uniqueSuffix}${path.extname(file.originalname)}`;
          uploadedFilenames.push(filename); // Track for cleanup
          
          // Upload to GridFS
          const uploadPromise = new Promise((resolve, reject) => {
            const uploadStream = gridFSBucket.openUploadStream(filename, {
              contentType: file.mimetype,
              metadata: {
                originalName: file.originalname,
                uploadedAt: new Date()
              }
            });
            
            uploadStream.on('finish', () => {
              const imagePath = `/api/images/${filename}`;
              newImages.push(imagePath);
              console.log(`✓ Image uploaded to GridFS: ${filename} -> ${imagePath}`);
              resolve();
            });
            
            uploadStream.on('error', (error) => {
              console.error(`✗ Error uploading image ${filename}:`, error);
              // Remove from tracking array on error
              const index = uploadedFilenames.indexOf(filename);
              if (index > -1) {
                uploadedFilenames.splice(index, 1);
              }
              reject(error);
            });
            
            // Write buffer to GridFS
            uploadStream.end(file.buffer);
          });
          
          uploadPromises.push(uploadPromise);
        } else {
          console.log(`Field ${fieldName}: No file or empty array`);
        }
      });
      
      // Wait for all images to upload
      if (uploadPromises.length > 0) {
        console.log(`Waiting for ${uploadPromises.length} image(s) to upload...`);
        await Promise.all(uploadPromises);
        if (newImages.length > 0) {
          // Start with existing images, then add new ones
          let finalImages = existingCampaign.images || [];
          console.log('=== BEFORE REMOVAL ===');
          console.log('Existing images:', finalImages);
          console.log('campaignData.imagesToRemove:', campaignData.imagesToRemove);
          console.log('Type of imagesToRemove:', typeof campaignData.imagesToRemove);
          console.log('Is array?', Array.isArray(campaignData.imagesToRemove));
          
          // Remove images marked for removal
          if (campaignData.imagesToRemove && Array.isArray(campaignData.imagesToRemove) && campaignData.imagesToRemove.length > 0) {
            console.log('=== REMOVING IMAGES ===');
            console.log('Images to remove:', campaignData.imagesToRemove);
            console.log('Before filter - finalImages:', finalImages);
            finalImages = finalImages.filter(img => {
              const shouldKeep = !campaignData.imagesToRemove.includes(img);
              console.log(`  Image: ${img}, Should keep: ${shouldKeep}`);
              return shouldKeep;
            });
            console.log(`After filter - Removed ${campaignData.imagesToRemove.length} image(s), ${finalImages.length} remaining`);
            console.log('After filter - finalImages:', finalImages);
            
            // Delete images from GridFS
            for (const imagePath of campaignData.imagesToRemove) {
              try {
                // Extract filename from path (e.g., /api/images/campaign-123.jpg -> campaign-123.jpg)
                const filename = imagePath.replace('/api/images/', '');
                if (filename) {
                  // Find the file in GridFS
                  const filesCollection = db.collection('images.files');
                  const file = await filesCollection.findOne({ filename: filename });
                  if (file) {
                    await gridFSBucket.delete(file._id);
                    console.log(`✓ Deleted image from GridFS: ${filename}`);
                  } else {
                    console.log(`⚠ Image not found in GridFS: ${filename}`);
                  }
                }
              } catch (deleteError) {
                console.error(`✗ Error deleting image ${imagePath}:`, deleteError);
              }
            }
          }
          
          // Add new images
          campaignData.images = [...finalImages, ...newImages];
          console.log('✓ Images array updated in campaignData:', campaignData.images);
          console.log(`  - Existing images (after removal): ${finalImages.length}`);
          console.log(`  - New images: ${newImages.length}`);
          console.log(`  - Total images: ${campaignData.images.length}`);
        } else {
          // No new images, but may need to remove existing ones
          let finalImages = existingCampaign.images || [];
          if (campaignData.imagesToRemove && Array.isArray(campaignData.imagesToRemove)) {
            console.log('=== REMOVING IMAGES (NO NEW UPLOADS) ===');
            console.log('Images to remove:', campaignData.imagesToRemove);
            finalImages = finalImages.filter(img => !campaignData.imagesToRemove.includes(img));
            console.log(`Removed ${campaignData.imagesToRemove.length} image(s), ${finalImages.length} remaining`);
            
            // Delete images from GridFS
            for (const imagePath of campaignData.imagesToRemove) {
              try {
                const filename = imagePath.replace('/api/images/', '');
                if (filename) {
                  const filesCollection = db.collection('images.files');
                  const file = await filesCollection.findOne({ filename: filename });
                  if (file) {
                    await gridFSBucket.delete(file._id);
                    console.log(`✓ Deleted image from GridFS: ${filename}`);
                  }
                }
              } catch (deleteError) {
                console.error(`✗ Error deleting image ${imagePath}:`, deleteError);
              }
            }
          }
          campaignData.images = finalImages;
          console.log('⚠ No images were successfully uploaded, updated existing images list');
        }
      } else {
        // No new uploads, but may need to remove existing ones
        let finalImages = existingCampaign.images || [];
        if (campaignData.imagesToRemove && Array.isArray(campaignData.imagesToRemove)) {
          console.log('=== REMOVING IMAGES (NO NEW UPLOADS) ===');
          console.log('Images to remove:', campaignData.imagesToRemove);
          finalImages = finalImages.filter(img => !campaignData.imagesToRemove.includes(img));
          console.log(`Removed ${campaignData.imagesToRemove.length} image(s), ${finalImages.length} remaining`);
          
          // Delete images from GridFS
          for (const imagePath of campaignData.imagesToRemove) {
            try {
              const filename = imagePath.replace('/api/images/', '');
              if (filename) {
                const filesCollection = db.collection('images.files');
                const file = await filesCollection.findOne({ filename: filename });
                if (file) {
                  await gridFSBucket.delete(file._id);
                  console.log(`✓ Deleted image from GridFS: ${filename}`);
                }
              }
            } catch (deleteError) {
              console.error(`✗ Error deleting image ${imagePath}:`, deleteError);
            }
          }
        }
        campaignData.images = finalImages;
        console.log('⚠ No image upload promises created, updated existing images list');
      }
    } else {
      // No files uploaded, but may need to remove existing ones
      let finalImages = existingCampaign.images || [];
      if (campaignData.imagesToRemove && Array.isArray(campaignData.imagesToRemove)) {
        console.log('=== REMOVING IMAGES (NO FILES) ===');
        console.log('Images to remove:', campaignData.imagesToRemove);
        finalImages = finalImages.filter(img => !campaignData.imagesToRemove.includes(img));
        console.log(`Removed ${campaignData.imagesToRemove.length} image(s), ${finalImages.length} remaining`);
        
        // Delete images from GridFS
        for (const imagePath of campaignData.imagesToRemove) {
          try {
            const filename = imagePath.replace('/api/images/', '');
            if (filename) {
              const filesCollection = db.collection('images.files');
              const file = await filesCollection.findOne({ filename: filename });
              if (file) {
                await gridFSBucket.delete(file._id);
                console.log(`✓ Deleted image from GridFS: ${filename}`);
              }
            }
          } catch (deleteError) {
            console.error(`✗ Error deleting image ${imagePath}:`, deleteError);
          }
        }
      }
      campaignData.images = finalImages;
      console.log('⚠ req.files is null/undefined - updated existing images list');
    }
    
    // Remove imagesToRemove from campaignData before saving (it's not a campaign field)
    delete campaignData.imagesToRemove;
    
    console.log('=== FINAL campaignData.images before update ===');
    console.log('campaignData.images:', campaignData.images);
    console.log('campaignData.images type:', typeof campaignData.images);
    console.log('campaignData.images isArray:', Array.isArray(campaignData.images));
    
    // Note: campaignId in URL is MongoDB _id, campaignId in body is human-readable ID
    // No need to compare them as they serve different purposes
    
    // Validate tag numbers for uniqueness
    if (campaignData.channels && Array.isArray(campaignData.channels)) {
      // Collect all tagNumbers, filtering out empty, null, undefined values
      const tagNumbers = campaignData.channels
        .map(channel => channel.tagNumber)
        .filter(tag => tag !== null && tag !== undefined && typeof tag === 'string' && tag.trim() !== '')
        .map(tag => tag.trim()); // Normalize by trimming
      
      console.log(`Update: Total channels: ${campaignData.channels.length}, Valid tagNumbers: ${tagNumbers.length}`);
      console.log(`Update: TagNumbers found: ${JSON.stringify(tagNumbers)}`);
      
      if (tagNumbers.length > 0) {
        // Check for duplicates within the same campaign
        const uniqueTags = new Set(tagNumbers);
        if (uniqueTags.size !== tagNumbers.length) {
          // Find tags that appear multiple times with their counts
          const tagCounts = {};
          tagNumbers.forEach(tag => {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          });
          
          // Only include tags that appear more than once
          const actualDuplicates = Object.entries(tagCounts)
            .filter(([tag, count]) => count > 1)
            .map(([tag, count]) => `${tag} (appears ${count} times)`);
          
          console.log(`Update: Duplicate tags within campaign: ${JSON.stringify(actualDuplicates)}`);
          console.log(`Update: Full tagNumbers array: ${JSON.stringify(tagNumbers)}`);
          console.log(`Update: Tag counts: ${JSON.stringify(tagCounts)}`);
          
          if (actualDuplicates.length > 0) {
            return res.status(400).json({ 
              error: `Duplicate reference codes found within the campaign: ${actualDuplicates.join(', ')}. Each reference code must be unique.` 
            });
          }
        }
        
        // Check for duplicates across all existing campaigns (excluding current campaign)
        const existingCampaigns = await campaigns.find({}).toArray();
        const existingTags = new Set();
        
        console.log(`Update: Checking tag uniqueness for campaign ${campaignId}`);
        console.log(`Update: Current campaign has tags: ${tagNumbers.join(', ')}`);
        
        existingCampaigns.forEach(campaign => {
          // Skip current campaign by comparing MongoDB _id
          if (campaign._id.toString() !== campaignId) {
            if (campaign.channels && Array.isArray(campaign.channels)) {
              campaign.channels.forEach(channel => {
                if (channel.tagNumber) {
                  existingTags.add(channel.tagNumber);
                }
              });
            }
          }
        });
        
        console.log(`Update: Found existing tags from other campaigns: ${Array.from(existingTags).join(', ')}`);
        
        const duplicateTags = tagNumbers.filter(tag => existingTags.has(tag));
        if (duplicateTags.length > 0) {
          console.log(`Update: Duplicate tags found: ${duplicateTags.join(', ')}`);
          return res.status(400).json({ 
            error: `Reference code(s) already exist: ${duplicateTags.join(', ')}. Each reference code must be globally unique.` 
          });
        }
        
        console.log(`Update: All tags are unique, proceeding with update`);
      }
    }
    
    // Update the campaign in database
    console.log('=== SAVING UPDATED CAMPAIGN TO DATABASE ===');
    console.log('campaignId (MongoDB _id):', campaignId);
    console.log('campaignData.images before save:', campaignData.images);
    console.log('campaignData keys:', Object.keys(campaignData));
    
    try {
      const result = await campaigns.updateOne(
        { _id: objectId },
        { $set: campaignData },
        { upsert: false }
      );
      
      console.log('=== DATABASE UPDATE RESULT ===');
      console.log('Matched:', result.matchedCount);
      console.log('Modified:', result.modifiedCount);
      
      if (result.matchedCount === 0) {
        console.log(`Campaign not found with _id: ${campaignId}`);
        return res.status(404).json({ error: 'Campaign not found' });
      }
      
      // Verify the updated document
      const updatedCampaign = await campaigns.findOne({ _id: objectId });
      console.log('=== VERIFIED UPDATED CAMPAIGN ===');
      console.log('updatedCampaign.images:', updatedCampaign?.images);
      console.log('updatedCampaign.images type:', typeof updatedCampaign?.images);
      console.log('updatedCampaign.images isArray:', Array.isArray(updatedCampaign?.images));

      // Sync tag counters after update to ensure consistency
      await syncTagCounters();
      
      return res.status(200).json({ 
        message: 'Campaign updated successfully', 
        campaignId 
      });
    } catch (dbErr) {
      // Handle duplicate key errors (MongoDB error code 11000)
      if (dbErr.code === 11000 || dbErr.codeName === 'DuplicateKey') {
        console.error('Duplicate key error during campaign update:', dbErr);
        const duplicateField = dbErr.keyPattern ? Object.keys(dbErr.keyPattern)[0] : 'campaignId';
        return res.status(409).json({ 
          error: `Duplicate ${duplicateField} detected. This may be due to concurrent requests. Please refresh and try again.`,
          duplicateField: duplicateField,
          details: 'A campaign with this identifier already exists or was just updated by another request.'
        });
      }
      // Re-throw other database errors to be caught by outer catch
      throw dbErr;
    }
  } catch (err) {
    console.error('Error updating campaign:', err);
    
    // Cleanup: Delete newly uploaded images if campaign update failed
    if (uploadedFilenames && uploadedFilenames.length > 0) {
      console.log(`⚠ Campaign update failed. Cleaning up ${uploadedFilenames.length} newly uploaded image(s)...`);
      
      for (const filename of uploadedFilenames) {
        try {
          // Find the file in GridFS by filename
          const filesCollection = db.collection('images.files');
          const file = await filesCollection.findOne({ filename: filename });
          if (file) {
            await gridFSBucket.delete(file._id);
            console.log(`✓ Cleaned up orphaned image: ${filename} (ID: ${file._id})`);
          } else {
            console.log(`⚠ Image not found in GridFS for cleanup: ${filename}`);
          }
        } catch (cleanupError) {
          console.error(`✗ Error cleaning up image ${filename}:`, cleanupError);
          // Continue cleanup even if one fails
        }
      }
    }
    
    // If it's already a 409 response, don't override it
    if (err.status === 409) {
      throw err;
    }
    
    console.error('Error details:', {
      message: err.message,
      stack: err.stack,
      campaignId: req.params.campaignId,
      bodyKeys: req.body ? Object.keys(req.body) : 'no body'
    });
    
    // Provide more specific error messages
    if (err.message && err.message.includes('ObjectId')) {
      return res.status(400).json({ error: 'Invalid campaign ID format', details: err.message });
    }
    
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET: Retrieve all campaigns
app.get('/api/campaigns', async (req, res) => {
  console.log('Received GET request for all campaigns (/api/campaigns)');
  try {
    const campaigns = db.collection('campaigns');
    const allCampaigns = await campaigns.find().toArray();
    res.status(200).json(allCampaigns);
  } catch (err) {
    console.error('Error retrieving campaigns:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET: Export all campaigns to Excel
// GET: Find campaigns by tag number (for debugging)
app.get('/api/campaigns/tag/:tagNumber', async (req, res) => {
  try {
    const tagNumber = req.params.tagNumber;
    const campaigns = db.collection('campaigns');
    
    const campaignsWithTag = await campaigns.find({
      'channels.tagNumber': tagNumber
    }).toArray();
    
    if (campaignsWithTag.length === 0) {
      return res.status(404).json({ 
        error: `No marketing initiatives found using reference code: ${tagNumber}` 
      });
    }
    
    res.json({
      tagNumber: tagNumber,
      campaigns: campaignsWithTag.map(c => ({
        _id: c._id,
        campaignId: c.campaignId,
        name: c.name,
        channels: c.channels.filter(ch => ch.tagNumber === tagNumber)
      })),
      count: campaignsWithTag.length
    });
  } catch (err) {
    console.error('Error finding campaigns by tag:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET: Export a single campaign to Excel
app.get('/api/campaigns/:campaignId/export', async (req, res) => {
  try {
    const campaigns = db.collection('campaigns');
    let campaign = null;
    
    // Try to find by ObjectId first (if it's a valid ObjectId)
    if (ObjectId.isValid(req.params.campaignId)) {
      try {
        campaign = await findCampaignByObjectId(req.params.campaignId);
      } catch (err) {
        // If ObjectId lookup fails, try campaignId lookup below
      }
    }
    
    // If not found by ObjectId, try to find by human-readable campaignId
    if (!campaign) {
      campaign = await campaigns.findOne({ campaignId: req.params.campaignId });
    }
    
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('Campaigns');
    worksheet.columns = [
      { header: 'Marketing ID', key: 'campaignId', width: 15 },
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Description', key: 'description', width: 30 },
      { header: 'Start Date', key: 'startDate', width: 15 },
      { header: 'End Date', key: 'endDate', width: 15 },
      { header: 'Budget (AED)', key: 'budget', width: 10 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Job Assigned To', key: 'jobAssignedTo', width: 15 },
      { header: 'Channels', key: 'channels', width: 50 },
    ];

    // Format channels as readable string (same as all-campaigns export)
    let channelDetails = '';
    if (campaign.channels && Array.isArray(campaign.channels)) {
      channelDetails = campaign.channels.map(channel => {
        let baseInfo = '';
        if (channel.type === 'Social Media') {
          baseInfo = `Social Media: ${channel.platform}, ${channel.adName}, ${channel.cost} AED, ${channel.adType}`;
        } else if (channel.type === 'Television') {
          baseInfo = `Television: ${channel.adName}, ${channel.cost} AED`;
        } else if (channel.type === 'Print Media') {
          baseInfo = `Print Media: ${channel.publication}, ${channel.adName}, ${channel.cost} AED`;
        } else if (channel.type === 'Radio') {
          baseInfo = `Radio: ${channel.station || ''}, ${channel.adName}, ${channel.cost} AED`;
        } else {
          baseInfo = `${channel.type}: ${channel.adName}, ${channel.cost} AED`;
        }
        
        // Add impressions if available
        if (channel.impressions) {
          baseInfo += `, ${channel.impressions.toLocaleString()} impressions`;
        }
        
        // Add tag number if available
        if (channel.tagNumber) {
          baseInfo += `, Reference Code: ${channel.tagNumber}`;
        }
        
        return baseInfo;
      }).join('; ');
    }

    worksheet.addRow({
      campaignId: campaign.campaignId,
      name: campaign.name,
      description: campaign.description,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      budget: campaign.budget,
      status: campaign.status,
      channels: channelDetails,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=campaign_${campaign.campaignId || campaign._id}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    if (err.message === 'Invalid ObjectId format') {
      return res.status(400).json({ error: 'Invalid campaign ID format' });
    }
    console.error('Error exporting campaign:', err);
    res.status(500).json({ error: 'Server error during export' });
  }
});

app.get('/api/campaigns/export', async (req, res) => {
  console.log('Received GET request for Excel export (/api/campaigns/export)');
  try {
    const campaigns = db.collection('campaigns');
    const data = await campaigns.find().toArray();
    
    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('Campaigns');
    
    worksheet.columns = [
      { header: 'Marketing ID', key: 'campaignId', width: 15 },
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Description', key: 'description', width: 30 },
      { header: 'Start Date', key: 'startDate', width: 15 },
      { header: 'End Date', key: 'endDate', width: 15 },
      { header: 'Budget (AED)', key: 'budget', width: 10 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Job Assigned To', key: 'jobAssignedTo', width: 15 },
      { header: 'Channels', key: 'channels', width: 50 },
    ];
    
    if (data.length === 0) {
      console.log('No campaigns found for export. Creating empty Excel file with headers.');
      // Add a message row to indicate no data
      worksheet.addRow({
        campaignId: 'No marketing records found',
        name: '',
        description: '',
        startDate: '',
        endDate: '',
        budget: '',
        status: '',
        jobAssignedTo: '',
        channels: ''
      });
    } else {
      data.forEach(campaign => {
      const channelDetails = campaign.channels ? campaign.channels.map(channel => {
        let baseInfo = '';
        if (channel.type === 'Social Media') {
          baseInfo = `Social Media: ${channel.platform}, ${channel.adName}, ${channel.cost} AED, ${channel.adType}`;
        } else if (channel.type === 'Television') {
          baseInfo = `Television: ${channel.adName}, ${channel.cost} AED`;
        } else if (channel.type === 'Print Media') {
          baseInfo = `Print Media: ${channel.publication}, ${channel.adName}, ${channel.cost} AED`;
        } else if (channel.type === 'Radio') {
          baseInfo = `Radio: ${channel.station || ''}, ${channel.adName}, ${channel.cost} AED`;
        } else if (channel.type === 'Storefront') {
          baseInfo = `Storefront: ${channel.platform || ''}, ${channel.adName}, ${channel.cost} AED`;
        } else if (channel.type === 'Email') {
          baseInfo = `Email: ${channel.platform || ''}, ${channel.adName}, ${channel.cost} AED`;
        } else if (channel.type === 'YouTube') {
          baseInfo = `YouTube: ${channel.platform || ''}, ${channel.adName}, ${channel.cost} AED`;
        } else if (channel.type === 'WhatsApp Group') {
          baseInfo = `WhatsApp Group: ${channel.platform || ''}, ${channel.adName}, ${channel.cost} AED`;
        } else {
          baseInfo = `${channel.type}: ${channel.adName}, ${channel.cost} AED`;
        }
        
        // Add impressions if available
        if (channel.impressions) {
          baseInfo += `, ${channel.impressions.toLocaleString()} impressions`;
        }
        
        // Add tag number if available
        if (channel.tagNumber) {
          baseInfo += `, Reference Code: ${channel.tagNumber}`;
        }
        
        return baseInfo;
      }).join('; ') : '';
      
        worksheet.addRow({
          campaignId: campaign.campaignId,
          name: campaign.name,
          description: campaign.description,
          startDate: campaign.startDate,
          endDate: campaign.endDate,
          budget: campaign.budget,
          status: campaign.status,
          channels: channelDetails,
        });
      });
    }
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=campaigns.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exporting campaigns:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// GET: Get all unique channel tags from campaigns (marketing records)
// MUST be before /api/campaigns/:campaignId route to avoid route conflict
app.get('/api/campaigns/channel-tags', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected', tags: [] });
    }
    
    const campaigns = db.collection('campaigns');
    const allCampaigns = await campaigns.find({}).toArray();
    
    // Extract unique channel tags from all campaigns
    const uniqueTags = new Set();
    allCampaigns.forEach(campaign => {
      if (campaign.channels && Array.isArray(campaign.channels)) {
        campaign.channels.forEach(channel => {
          if (channel.channelTag && channel.channelTag.trim() !== '') {
            uniqueTags.add(channel.channelTag.trim());
          }
        });
      }
    });
    
    res.json({ tags: Array.from(uniqueTags).sort() });
  } catch (err) {
    console.error('Error fetching channel tags from campaigns:', err);
    res.json({ tags: [] });
  }
});

// GET: Query campaigns by campaignId
app.get('/api/campaigns/:campaignId', async (req, res) => {
  console.log(`Received GET request for campaignId: ${req.params.campaignId}`);
  try {
    const campaigns = db.collection('campaigns');
    let campaign = null;
    
    // Try to find by ObjectId first (if it's a valid ObjectId)
    if (ObjectId.isValid(req.params.campaignId)) {
      try {
        campaign = await findCampaignByObjectId(req.params.campaignId);
      } catch (err) {
        // If ObjectId lookup fails, try campaignId lookup below
      }
    }
    
    // If not found by ObjectId, try to find by human-readable campaignId
    if (!campaign) {
      campaign = await campaigns.findOne({ campaignId: req.params.campaignId });
    }
    
    if (campaign) {
      res.status(200).json(campaign);
    } else {
      res.status(404).json({ error: 'Campaign not found' });
    }
  } catch (err) {
    if (err.message === 'Invalid ObjectId format') {
      return res.status(400).json({ error: 'Invalid campaign ID format' });
    }
    console.error('Error querying campaign:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE: Delete campaign by MongoDB _id
app.delete('/api/campaigns/:campaignId', async (req, res) => {
  console.log(`Received DELETE request for campaignId: ${req.params.campaignId}`);
  try {
    const campaignId = req.params.campaignId;
    const campaigns = db.collection('campaigns');
    
    // Validate ObjectId format
    if (!ObjectId.isValid(campaignId)) {
      return res.status(400).json({ error: 'Invalid campaign ID format' });
    }
    
    const objectId = new ObjectId(campaignId);
    
    // Find the campaign first to get image paths
    const campaign = await campaigns.findOne({ _id: objectId });
    
    if (!campaign) {
      console.log(`Campaign not found for deletion: ${campaignId}`);
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    // Delete associated images from GridFS (wrap in try-catch to ensure campaign deletion happens even if image deletion fails)
    // Initialize counters in outer scope so they're accessible in the response
    let deletedCount = 0;
    let errorCount = 0;
    let imagesToDelete = [];
    
    try {
      console.log('=== CHECKING CAMPAIGN IMAGES ===');
      console.log('campaign.images:', campaign.images);
      console.log('campaign.images type:', typeof campaign.images);
      console.log('campaign.images isArray:', Array.isArray(campaign.images));
      
      // Handle both array and string formats
      if (campaign.images) {
        if (Array.isArray(campaign.images)) {
          imagesToDelete = campaign.images.filter(img => img && img.trim() !== '');
        } else if (typeof campaign.images === 'string' && campaign.images.trim() !== '') {
          imagesToDelete = [campaign.images.trim()];
        }
      }
      
      if (imagesToDelete.length > 0) {
        console.log(`=== DELETING CAMPAIGN IMAGES ===`);
        console.log(`Found ${imagesToDelete.length} image(s) to delete`);
        console.log('Image paths:', imagesToDelete);
        
        // Check if gridFSBucket is initialized
        if (!gridFSBucket) {
          console.error('⚠ gridFSBucket is not initialized! Cannot delete images.');
        } else {
          for (const imagePath of imagesToDelete) {
            try {
              console.log(`Processing image: ${imagePath}`);
              
              // Robust filename extraction - handle multiple path formats
              let filename = '';
              if (typeof imagePath === 'string') {
                // If it's already just a filename (no path separators)
                if (!imagePath.includes('/') && !imagePath.includes('\\')) {
                  filename = imagePath.trim();
                } else {
                  // Extract filename from various path formats:
                  // - /api/images/filename.jpg
                  // - api/images/filename.jpg
                  // - /uploads/filename.jpg
                  // - C:\path\to\filename.jpg
                  // - https://example.com/path/filename.jpg
                  const pathParts = imagePath.split(/[/\\]/);
                  filename = pathParts[pathParts.length - 1].trim();
                  
                  // If it still contains the prefix, try to remove it
                  if (filename.startsWith('api/images/')) {
                    filename = filename.replace('api/images/', '');
                  }
                }
              }
              
              console.log(`Extracted filename: ${filename}`);
              
              if (filename) {
                // Find the file in GridFS
                const filesCollection = db.collection('images.files');
                const file = await filesCollection.findOne({ filename: filename });
                
                if (file) {
                  console.log(`Found file in GridFS with _id: ${file._id}`);
                  await gridFSBucket.delete(file._id);
                  deletedCount++;
                  console.log(`✓ Deleted image from GridFS: ${filename}`);
                } else {
                  console.log(`⚠ Image not found in GridFS: ${filename} (may have been deleted already)`);
                  // Try to find by partial match (in case path format is different)
                  const allFiles = await filesCollection.find({}).toArray();
                  const matchingFile = allFiles.find(f => f.filename.includes(filename) || filename.includes(f.filename));
                  if (matchingFile) {
                    console.log(`Found matching file: ${matchingFile.filename}, deleting...`);
                    await gridFSBucket.delete(matchingFile._id);
                    deletedCount++;
                    console.log(`✓ Deleted matching image from GridFS: ${matchingFile.filename}`);
                  }
                }
              } else {
                console.log(`⚠ Could not extract filename from path: ${imagePath}`);
              }
            } catch (deleteError) {
              errorCount++;
              console.error(`✗ Error deleting image ${imagePath}:`, deleteError);
              console.error('Error stack:', deleteError.stack);
              // Continue with other images even if one fails
            }
          }
          
          console.log(`=== IMAGE DELETION SUMMARY ===`);
          console.log(`Total images processed: ${imagesToDelete.length}`);
          console.log(`Successfully deleted: ${deletedCount}`);
          console.log(`Errors: ${errorCount}`);
        }
      } else {
        console.log('No images found in campaign, skipping image deletion');
        console.log('campaign.images value:', campaign.images);
      }
    } catch (imageError) {
      // Log image deletion errors but don't stop campaign deletion
      console.error('Error during image deletion (continuing with campaign deletion):', imageError);
      console.error('Image error stack:', imageError.stack);
    }
    
    // Delete the campaign document (this should ALWAYS happen, even if image deletion fails)
    console.log(`=== DELETING CAMPAIGN DOCUMENT ===`);
    console.log(`Attempting to delete campaign with _id: ${objectId}`);
    const result = await campaigns.deleteOne({ _id: objectId });
    
    console.log(`Delete result: matchedCount=${result.matchedCount}, deletedCount=${result.deletedCount}`);
    
    if (result.deletedCount === 1) {
      console.log(`✓ Campaign deleted successfully: ${campaignId}`);
      res.status(200).json({ 
        message: 'Campaign deleted successfully',
        imagesDeleted: deletedCount,  // Use actual count of successfully deleted images
        imagesProcessed: imagesToDelete.length,  // Total images that were attempted
        imageErrors: errorCount  // Number of images that failed to delete
      });
    } else {
      console.log(`✗ Campaign deletion failed: ${campaignId}`);
      console.log(`  - matchedCount: ${result.matchedCount}`);
      console.log(`  - deletedCount: ${result.deletedCount}`);
      res.status(404).json({ error: 'Campaign not found or could not be deleted' });
    }
  } catch (err) {
    console.error('Error deleting campaign:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// PUT: Update impressions for a specific tag number
app.put('/api/campaigns/impressions/:tagNumber', async (req, res) => {
  const tagNumber = req.params.tagNumber;
  const { impressions } = req.body;
  
  console.log(`Updating impressions for tag ${tagNumber} to ${impressions}`);
  
  try {
    const campaigns = db.collection('campaigns');
    
    // Validate impressions is a number
    if (typeof impressions !== 'number' || impressions < 0) {
      return res.status(400).json({ error: 'Impressions must be a positive number' });
    }
    
    // Find the campaign that contains this tag number and update the impressions
    const result = await campaigns.updateOne(
      { 'channels.tagNumber': tagNumber },
      { $set: { 'channels.$.impressions': impressions } }
    );
    
    console.log(`Update result: matched=${result.matchedCount}, modified=${result.modifiedCount}`);
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'No campaign found with this reference code' });
    }
    
    if (result.modifiedCount === 0) {
      return res.status(404).json({ error: 'Channel not found or no changes made' });
    }
    
    res.json({ 
      message: 'Impressions updated successfully',
      tagNumber: tagNumber,
      impressions: impressions
    });
  } catch (err) {
    console.error('Error updating impressions:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT: Update marketing achieved impressions and conversions
app.put('/api/campaigns/:campaignId/achieved', async (req, res) => {
  const { impressions, conversions } = req.body;
  
  console.log(`Updating marketing achieved for campaign ${req.params.campaignId}: impressions=${impressions}, conversions=${conversions}`);
  
  try {
    // Find campaign by ObjectId
    const campaign = await findCampaignByObjectId(req.params.campaignId);
    
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    // Validate impressions is a number
    if (typeof impressions !== 'number' || impressions < 0) {
      return res.status(400).json({ error: 'Impressions must be a positive number' });
    }
    
    // Validate conversions is a number
    if (typeof conversions !== 'number' || conversions < 0) {
      return res.status(400).json({ error: 'Conversions must be a positive number' });
    }
    
    const campaigns = db.collection('campaigns');
    
    // Update the campaign's achieved impressions and conversions using _id
    const result = await campaigns.updateOne(
      { _id: campaign._id },
      { $set: { 
        'achieved.impressions': impressions,
        'achieved.conversions': conversions
      } }
    );
    
    console.log(`Update result: matched=${result.matchedCount}, modified=${result.modifiedCount}`);
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    res.json({ 
      message: 'Marketing achieved impressions and conversions updated successfully',
      impressions: impressions,
      conversions: conversions
    });
  } catch (err) {
    if (err.message === 'Invalid ObjectId format') {
      return res.status(400).json({ error: 'Invalid campaign ID format' });
    }
    console.error('Error updating marketing achieved:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT: Update impressions for a specific platform in a campaign (fallback for channel index)
app.put('/api/campaigns/:campaignId/channels/:channelIndex/impressions', async (req, res) => {
  const channelIndex = parseInt(req.params.channelIndex);
  const { impressions } = req.body;
  
  console.log(`Updating impressions for campaign ${req.params.campaignId}, channel ${channelIndex} to ${impressions}`);
  
  try {
    // Find campaign by ObjectId
    const campaign = await findCampaignByObjectId(req.params.campaignId);
    
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    // Validate impressions is a number
    if (typeof impressions !== 'number' || impressions < 0) {
      return res.status(400).json({ error: 'Impressions must be a positive number' });
    }
    
    const campaigns = db.collection('campaigns');
    
    // Update the specific channel's impressions using _id
    const result = await campaigns.updateOne(
      { _id: campaign._id },
      { $set: { [`channels.${channelIndex}.impressions`]: impressions } }
    );
    
    console.log(`Update result: matched=${result.matchedCount}, modified=${result.modifiedCount}`);
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    if (result.modifiedCount === 0) {
      return res.status(404).json({ error: 'Channel not found or no changes made' });
    }
    
    res.json({ 
      message: 'Impressions updated successfully',
      impressions: impressions
    });
  } catch (err) {
    if (err.message === 'Invalid ObjectId format') {
      return res.status(400).json({ error: 'Invalid campaign ID format' });
    }
    console.error('Error updating impressions:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET: Get all unique tag numbers
app.get('/api/tags', async (req, res) => {
  try {
    const campaigns = db.collection('campaigns');
    const allCampaigns = await campaigns.find({}).toArray();
    
    const tags = new Set();
    allCampaigns.forEach(campaign => {
      if (campaign.channels && Array.isArray(campaign.channels)) {
        campaign.channels.forEach(channel => {
          if (channel.tagNumber) {
            tags.add(channel.tagNumber);
          }
        });
      }
    });
    
    res.json({
      tags: Array.from(tags).sort(),
      count: tags.size
    });
  } catch (err) {
    console.error('Error getting tags:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET: Get tag counters (for admin purposes)
app.get('/api/tags/counters', async (req, res) => {
  try {
    const tagCounters = db.collection('tagCounters');
    const counters = await tagCounters.find({}).toArray();
    
    // Function to get platform name from prefix
    function getPlatformName(prefix) {
      const platformMap = {
        'IG': 'Instagram',
        'FB': 'Facebook', 
        'TT': 'TikTok',
        'YT': 'YouTube',
        'SC': 'Snapchat',
        'GG': 'Google',
        'WA': 'WhatsApp Group',
        'GT': 'Gold councils',
        'RC': 'Residential Community',
        'LC': 'Lang/Cultural group',
        'RG': 'Religious group',
        'BC': 'Bluecollar Camp',
        'NC': 'Neighbourhood Community',
        'SO': 'Social organisations',
        'EV': 'Event',
        'EX': 'Exhibition',
        'CP': 'Channel Partners',
        'CO': 'Corporate Partners',
        'HT': 'Hotel',
        'TD': 'Tour Driver',
        'TC': 'Tours&Travel Agency',
        'PL': 'New collection Launch',
        'WS': 'Website',
        'EM': 'Email',
        'SMS': 'SMS',
        'PM': 'Print Media',
        'RD': 'Radio',
        'TV': 'Television',
        'RF': 'Referral',
        'SF': 'Storefront',
        'OA': 'Outdoor Ads',
        'OT': 'Others'
      };
      return platformMap[prefix] || prefix;
    }

    // Format counters for display
    const formattedCounters = counters.map(counter => ({
      prefix: counter.prefix,
      platformName: getPlatformName(counter.prefix),
      lastNumber: counter.lastNumber,
      nextTag: `${counter.prefix}${String(counter.lastNumber + 1).padStart(5, '0')}`
    }));
    
    res.json({
      counters: formattedCounters,
      count: counters.length
    });
  } catch (err) {
    console.error('Error getting tag counters:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST: Generate unique tag number (using last saved counter)
app.post('/api/tags/generate', async (req, res) => {
  const { channelType, platform } = req.body;
  
  // Trim whitespace from channelType
  const trimmedChannelType = channelType ? channelType.trim() : '';
  
  console.log('Tag generation request:', { channelType: trimmedChannelType, platform });
  console.log('Platform type:', typeof platform);
  console.log('Platform length:', platform ? platform.length : 'null');
  console.log('Platform exact match with Whatsup group:', platform === 'Whatsup group');
  
  if (!trimmedChannelType) {
    return res.status(400).json({ error: 'Please select a channel type' });
  }
  
  // Check if database is initialized
  if (!db) {
    console.error('Database not initialized');
    return res.status(500).json({ error: 'Database connection not available' });
  }
  
  // Declare prefix outside try block so it's accessible in catch block
  let prefix = '';
  
  try {
    // Determine prefix based on channel type and platform
    if (trimmedChannelType === 'Instagram') {
      prefix = 'IG';
    } else if (trimmedChannelType === 'Facebook') {
      prefix = 'FB';
    } else if (trimmedChannelType === 'TikTok') {
      prefix = 'TT';
    } else if (trimmedChannelType === 'YouTube') {
      prefix = 'YT';
    } else if (trimmedChannelType === 'Snapchat') {
      prefix = 'SC';
    } else if (trimmedChannelType === 'Google') {
      prefix = 'GG';
    } else if (trimmedChannelType === 'WhatsApp Group') {
      prefix = 'WA';
    } else if (trimmedChannelType === 'Gold councils') {
      prefix = 'GT';
    } else if (trimmedChannelType === 'Residential Community') {
      prefix = 'RC';
    } else if (trimmedChannelType === 'Lang/Cultural group') {
      prefix = 'LC';
    } else if (trimmedChannelType === 'Religious group') {
      prefix = 'RG';
    } else if (trimmedChannelType === 'Bluecollar Camp') {
      prefix = 'BC';
    } else if (trimmedChannelType === 'Neighbourhood Community') {
      prefix = 'NC';
    } else if (trimmedChannelType === 'Social organisations') {
      prefix = 'SO';
    } else if (trimmedChannelType === 'Event') {
      prefix = 'EV';
    } else if (trimmedChannelType === 'Exhibition') {
      prefix = 'EX';
    } else if (trimmedChannelType === 'Channel Partners') {
      prefix = 'CP';
    } else if (trimmedChannelType === 'Corporate Partners') {
      prefix = 'CO';
    } else if (trimmedChannelType === 'Hotel') {
      prefix = 'HT';
    } else if (trimmedChannelType === 'Tour Driver') {
      prefix = 'TD';
    } else if (trimmedChannelType === 'Tours&Travel Agency') {
      prefix = 'TC';
    } else if (trimmedChannelType === 'New collection Launch') {
      prefix = 'PL';
    } else if (trimmedChannelType === 'Website') {
      prefix = 'WS';
    } else if (trimmedChannelType === 'Email') {
      prefix = 'EM';
    } else if (trimmedChannelType === 'SMS') {
      prefix = 'SMS';
    } else if (trimmedChannelType === 'Print Media') {
      prefix = 'PM';
    } else if (trimmedChannelType === 'Radio') {
      prefix = 'RD';
    } else if (trimmedChannelType === 'Television') {
      prefix = 'TV';
    } else if (trimmedChannelType === 'Referral') {
      prefix = 'RF';
    } else if (trimmedChannelType === 'Storefront') {
      prefix = 'SF';
    } else if (trimmedChannelType === 'Outdoor Ads') {
      prefix = 'OA';
    } else if (trimmedChannelType === 'Others') {
      prefix = 'OT';
    } else {
      // If no channel type selected, return error
      console.error('Unknown channel type:', trimmedChannelType);
      return res.status(400).json({ error: `Unknown channel type: ${trimmedChannelType}. Please select a valid channel type.` });
    }
    
    const tagCounters = db.collection('tagCounters');
    const campaigns = db.collection('campaigns');
    
    // ATOMIC: Use findOneAndUpdate with $inc to atomically allocate counter
    // This prevents race conditions where multiple requests get the same counter value
    const maxRetries = 10;
    let attempts = 0;
    
    while (attempts < maxRetries) {
      attempts++;
      
      // ATOMIC: Increment counter and get the new value in one operation
      // This ensures only one request gets each number, preventing duplicates
      const result = await tagCounters.findOneAndUpdate(
        { prefix: prefix },
        { 
          $inc: { lastNumber: 1 },
          $setOnInsert: { prefix: prefix } // Only set prefix if document doesn't exist (don't set lastNumber here to avoid conflict)
        },
        { 
          upsert: true,
          returnDocument: 'after' // Return the document after update
        }
      );
      
      // Handle different MongoDB driver versions (like getNextCampaignId does)
      let allocatedNumber;
      if (result && result.value) {
        // Older MongoDB driver format
        allocatedNumber = result.value.lastNumber;
        console.log('Using result.value.lastNumber:', allocatedNumber);
      } else if (result && result.lastNumber !== undefined) {
        // Newer MongoDB driver format
        allocatedNumber = result.lastNumber;
        console.log('Using result.lastNumber:', allocatedNumber);
      } else {
        // Fallback: result is null or invalid
        console.error(`findOneAndUpdate returned null or invalid result for prefix ${prefix} (attempt ${attempts})`);
        if (attempts < maxRetries) {
          // Retry
          continue;
        } else {
          throw new Error(`Failed to generate tag: Database operation returned invalid result for prefix ${prefix} after ${maxRetries} attempts`);
        }
      }
      
      const newTagNumber = `${prefix}${String(allocatedNumber).padStart(5, '0')}`;
      
      // Defense in depth: Check if this tag already exists (shouldn't happen with atomic increment)
      const existingTag = await campaigns.findOne({
        'channels.tagNumber': newTagNumber
      });
      
      if (!existingTag) {
        // Tag is available, return it
        console.log(`Generated unique tag: ${newTagNumber} for ${channelType}${platform ? ' - ' + platform : ''}`);
        return res.json({
          tagNumber: newTagNumber,
          prefix: prefix,
          counter: allocatedNumber,
          shouldIncrement: true
        });
      } else {
        // Tag exists (shouldn't happen with atomic increment, but handle it)
        console.warn(`Tag ${newTagNumber} already exists, retrying with next number... (attempt ${attempts})`);
        // Loop will retry with next incremented number
      }
    }
    
    // If we exhausted retries
    console.error(`Failed to generate unique tag after ${maxRetries} attempts for prefix ${prefix}`);
    return res.status(500).json({ 
      error: 'Failed to generate unique tag after multiple attempts. Please try again.' 
    });
  } catch (err) {
    console.error('Error generating tag:', err);
    console.error('Error details:', {
      message: err.message,
      stack: err.stack,
      channelType: trimmedChannelType,
      platform: platform,
      prefix: prefix || 'unknown'
    });
    res.status(500).json({ 
      error: 'Server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});



// GET: Get impression statistics for all campaigns
app.get('/api/impressions/stats', async (req, res) => {
  try {
    console.log('Impression stats endpoint called'); // Debug log
    const campaigns = db.collection('campaigns');
    const allCampaigns = await campaigns.find({}).toArray();
    console.log('Found campaigns:', allCampaigns.length); // Debug log
    
    const stats = {
      totalMarketingInitiatives: 0,
      totalImpressions: 0,
      totalConversions: 0,
      channelsByType: {}, // Changed from impressionsByChannel to track both impressions and conversions
      impressionsByPlatform: {},
      campaignsWithImpressions: 0
    };
    
    // Count total marketing initiatives (all campaigns)
    stats.totalMarketingInitiatives = allCampaigns.length;
    console.log('Total marketing initiatives (campaigns count):', stats.totalMarketingInitiatives);
    
    allCampaigns.forEach(campaign => {
      let campaignHasImpressions = false;
      console.log('Processing campaign:', campaign.campaignId, 'with channels:', campaign.channels?.length || 0); // Debug log
      console.log('Campaign raw data:', JSON.stringify(campaign, null, 2)); // Full campaign data
      
      // Calculate campaign-level impressions and conversions (from achieved field)
      const campaignImpressions = campaign.achieved?.impressions || 0;
      const campaignConversions = campaign.achieved?.conversions || 0;
      
      // Sum all impressions and conversions (including 0 values)
      stats.totalImpressions += campaignImpressions;
      stats.totalConversions += campaignConversions;
      
      if (campaignImpressions > 0) {
        campaignHasImpressions = true;
      }
      
      // Still track channel-level data for breakdowns and top performers
      if (campaign.channels && Array.isArray(campaign.channels)) {
        campaign.channels.forEach(channel => {
          const impressions = channel.impressions || 0;
          const conversions = channel.conversions || 0;
          console.log('Channel:', channel.type, 'Platform:', channel.platform, 'Impressions:', impressions, 'Conversions:', conversions); // Debug log
          console.log('Channel raw data:', JSON.stringify(channel, null, 2)); // Full channel data
          
          // Track by channel type (for breakdown display) - track all channels, not just those with impressions > 0
          if (channel.type) {
            if (!stats.channelsByType[channel.type]) {
              stats.channelsByType[channel.type] = {
                impressions: 0,
                conversions: 0
              };
            }
            stats.channelsByType[channel.type].impressions += impressions;
            stats.channelsByType[channel.type].conversions += conversions;
          }
          
          if (impressions > 0) {
            // Track by platform (for Social Media)
            if (channel.type === 'Social Media' && channel.platform) {
              if (!stats.impressionsByPlatform[channel.platform]) {
                stats.impressionsByPlatform[channel.platform] = 0;
              }
              stats.impressionsByPlatform[channel.platform] += impressions;
            }
          }
        });
      }
      
      if (campaignHasImpressions) {
        stats.campaignsWithImpressions++;
      }
    });
    
    console.log('Final stats being sent:', stats); // Debug log
    res.json(stats);
  } catch (err) {
    console.error('Error getting impression stats:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET: Serve images from GridFS
app.get('/api/images/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    // Check if file exists in GridFS
    const files = db.collection('images.files');
    const file = await files.findOne({ filename: filename });
    
    if (!file) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    // Set appropriate content type
    res.set('Content-Type', file.contentType || 'image/jpeg');
    res.set('Content-Length', file.length);
    
    // Stream file from GridFS
    const downloadStream = gridFSBucket.openDownloadStreamByName(filename);
    
    downloadStream.on('error', (error) => {
      console.error('Error streaming image:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error streaming image' });
      }
    });
    
    downloadStream.pipe(res);
  } catch (err) {
    console.error('Error serving image:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE: Delete image from GridFS
app.delete('/api/images/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    // Find the file in GridFS
    const files = db.collection('images.files');
    const file = await files.findOne({ filename: filename });
    
    if (!file) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    // Delete from GridFS
    await gridFSBucket.delete(file._id);
    
    res.json({ message: 'Image deleted successfully' });
  } catch (err) {
    console.error('Error deleting image:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Static file serving should come after API routes
app.use(express.static('.'));
app.use('/public', express.static(path.join(__dirname, 'public')));
// Keep /uploads for backward compatibility with existing images
app.use('/uploads', express.static('uploads'));

// ==================== Channel Collection API Endpoints ====================

// POST: Create a new channel
app.post('/api/channels', async (req, res) => {
  try {
    const { channelType, channelTag, addTag, mobileNo, totConversions, totImpressions, companyName } = req.body;
    
    // Validate required fields
    if (!channelType) {
      return res.status(400).json({ error: 'channelType is required' });
    }
    
    // Generate unique channel_id
    const channel_id = await getNextChannelId();
    
    const channel = {
      channel_id,
      channelType,
      channelTag: channelTag || '',
      addTag: addTag || '',
      mobileNo: mobileNo || '',
      totConversions: totConversions || 0,
      totImpressions: totImpressions || 0,
      companyName: companyName || '',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    const channels = db.collection('channels');
    await channels.insertOne(channel);
    
    console.log(`Created new channel: ${channel_id}`);
    res.status(201).json(channel);
  } catch (err) {
    console.error('Error creating channel:', err);
    if (err.code === 11000) {
      res.status(409).json({ error: 'Channel ID already exists' });
    } else {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

// GET: Get all channels
app.get('/api/channels', async (req, res) => {
  try {
    const channels = db.collection('channels');
    const allChannels = await channels.find({}).sort({ createdAt: -1 }).toArray();
    res.json(allChannels);
  } catch (err) {
    console.error('Error fetching channels:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET: Get all unique channel tags (MUST be before /api/channels/:id route)
// Optional query parameter: channelType - filters tags by channel type
app.get('/api/channels/tags', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected', tags: [] });
    }
    
    const channels = db.collection('channels');
    const { channelType } = req.query;
    
    // Build query filter
    const query = {};
    if (channelType && channelType.trim() !== '') {
      query.channelType = channelType.trim();
    }
    
    const allChannels = await channels.find(query).toArray();
    
    // Extract unique channel tags (filter out empty/null values)
    const uniqueTags = [...new Set(
      allChannels
        .map(channel => channel.channelTag)
        .filter(tag => tag && tag.trim() !== '')
    )].sort();
    
    res.json({ tags: uniqueTags });
  } catch (err) {
    console.error('Error fetching channel tags:', err);
    // Return empty array instead of error to prevent UI issues
    res.json({ tags: [] });
  }
});

// GET: Export all channels to Excel
app.get('/api/channels/export', async (req, res) => {
  console.log('Received GET request for Excel export (/api/channels/export)');
  try {
    const channels = db.collection('channels');
    const data = await channels.find().toArray();
    
    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('Channels');
    
    worksheet.columns = [
      { header: 'Channel ID', key: 'channel_id', width: 15 },
      { header: 'Channel Type', key: 'channelType', width: 20 },
      { header: 'Channel Tag', key: 'channelTag', width: 20 },
      { header: 'Add Tag', key: 'addTag', width: 20 },
      { header: 'Mobile No', key: 'mobileNo', width: 15 },
      { header: 'Company Name', key: 'companyName', width: 25 },
      { header: 'Total Impressions', key: 'totImpressions', width: 15 },
      { header: 'Total Conversions', key: 'totConversions', width: 15 },
      { header: 'Created At', key: 'createdAt', width: 20 },
      { header: 'Updated At', key: 'updatedAt', width: 20 },
    ];
    
    if (data.length === 0) {
      console.log('No channels found for export. Creating empty Excel file with headers.');
      // Add a message row to indicate no data
      worksheet.addRow({
        channel_id: 'No channels found',
        channelType: '',
        channelTag: '',
        addTag: '',
        mobileNo: '',
        companyName: '',
        totImpressions: '',
        totConversions: '',
        createdAt: '',
        updatedAt: ''
      });
    } else {
      data.forEach(channel => {
        worksheet.addRow({
          channel_id: channel.channel_id || '',
          channelType: channel.channelType || '',
          channelTag: channel.channelTag || '',
          addTag: channel.addTag || '',
          mobileNo: channel.mobileNo || '',
          companyName: channel.companyName || '',
          totImpressions: channel.totImpressions || 0,
          totConversions: channel.totConversions || 0,
          createdAt: channel.createdAt ? new Date(channel.createdAt).toLocaleString() : '',
          updatedAt: channel.updatedAt ? new Date(channel.updatedAt).toLocaleString() : '',
        });
      });
    }
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=channels.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exporting channels:', err);
    res.status(500).json({ error: 'Server error during export' });
  }
});

// ==================== EMPLOYEE API ENDPOINTS ====================

// POST: Create a new employee
app.post('/api/employees', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }
    
    const { name, email, phone, department, position } = req.body;
    
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }
    
    const employees = db.collection('employees');
    
    // Check if email already exists
    const existingEmployee = await employees.findOne({ email: email.trim() });
    if (existingEmployee) {
      return res.status(400).json({ error: 'Employee with this email already exists' });
    }
    
    // Generate employee ID
    const employee_id = await getNextEmployeeId();
    
    const newEmployee = {
      employee_id: employee_id,
      name: name.trim(),
      email: email.trim(),
      phone: phone ? phone.trim() : '',
      department: department ? department.trim() : '',
      position: position ? position.trim() : '',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    await employees.insertOne(newEmployee);
    res.status(201).json({ message: 'Employee created successfully', employee: newEmployee });
  } catch (err) {
    console.error('Error creating employee:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET: Get all employees
app.get('/api/employees', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }
    
    const employees = db.collection('employees');
    const allEmployees = await employees.find({}).sort({ createdAt: -1 }).toArray();
    res.json(allEmployees);
  } catch (err) {
    console.error('Error fetching employees:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET: Get a specific employee by ID
app.get('/api/employees/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }
    
    const employees = db.collection('employees');
    const employee = await employees.findOne({
      $or: [
        { _id: new ObjectId(req.params.id) },
        { employee_id: req.params.id }
      ]
    });
    
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    
    res.json(employee);
  } catch (err) {
    console.error('Error fetching employee:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT: Update an employee
app.put('/api/employees/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }
    
    const { name, email, phone, department, position } = req.body;
    
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }
    
    const employees = db.collection('employees');
    
    // Check if email is being changed and if it conflicts with another employee
    const currentEmployee = await employees.findOne({
      $or: [
        { _id: new ObjectId(req.params.id) },
        { employee_id: req.params.id }
      ]
    });
    
    if (!currentEmployee) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    
    if (email.trim() !== currentEmployee.email) {
      const existingEmployee = await employees.findOne({ email: email.trim() });
      if (existingEmployee) {
        return res.status(400).json({ error: 'Employee with this email already exists' });
      }
    }
    
    const updateData = {
      name: name.trim(),
      email: email.trim(),
      phone: phone ? phone.trim() : '',
      department: department ? department.trim() : '',
      position: position ? position.trim() : '',
      updatedAt: new Date()
    };
    
    const result = await employees.updateOne(
      {
        $or: [
          { _id: new ObjectId(req.params.id) },
          { employee_id: req.params.id }
        ]
      },
      { $set: updateData }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    
    const updatedEmployee = await employees.findOne({
      $or: [
        { _id: new ObjectId(req.params.id) },
        { employee_id: req.params.id }
      ]
    });
    
    res.json({ message: 'Employee updated successfully', employee: updatedEmployee });
  } catch (err) {
    console.error('Error updating employee:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE: Delete an employee
app.delete('/api/employees/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }
    
    const employees = db.collection('employees');
    const result = await employees.deleteOne({
      $or: [
        { _id: new ObjectId(req.params.id) },
        { employee_id: req.params.id }
      ]
    });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    
    res.json({ message: 'Employee deleted successfully' });
  } catch (err) {
    console.error('Error deleting employee:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET: Get a specific channel by ID
app.get('/api/channels/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const channels = db.collection('channels');
    
    // Try to find by channel_id first, then by _id
    let channel = await channels.findOne({ channel_id: id });
    if (!channel) {
      try {
        channel = await channels.findOne({ _id: new ObjectId(id) });
      } catch (e) {
        // Invalid ObjectId format
      }
    }
    
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    
    res.json(channel);
  } catch (err) {
    console.error('Error fetching channel:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT: Update a channel
app.put('/api/channels/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { channelType, channelTag, addTag, mobileNo, totConversions, totImpressions, companyName } = req.body;
    
    const channels = db.collection('channels');
    
    // Build update object
    const updateData = {
      updatedAt: new Date()
    };
    
    if (channelType !== undefined) updateData.channelType = channelType;
    if (channelTag !== undefined) updateData.channelTag = channelTag;
    if (addTag !== undefined) updateData.addTag = addTag;
    if (mobileNo !== undefined) updateData.mobileNo = mobileNo;
    if (totConversions !== undefined) updateData.totConversions = totConversions;
    if (totImpressions !== undefined) updateData.totImpressions = totImpressions;
    if (companyName !== undefined) updateData.companyName = companyName;
    
    // Try to find by channel_id first, then by _id
    let query = { channel_id: id };
    let channel = await channels.findOne(query);
    
    if (!channel) {
      try {
        query = { _id: new ObjectId(id) };
        channel = await channels.findOne(query);
      } catch (e) {
        // Invalid ObjectId format
      }
    }
    
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    
    const result = await channels.updateOne(
      query,
      { $set: updateData }
    );
    
    if (result.modifiedCount === 0) {
      return res.status(404).json({ error: 'Channel not found or no changes made' });
    }
    
    const updatedChannel = await channels.findOne(query);
    console.log(`Updated channel: ${id}`);
    res.json(updatedChannel);
  } catch (err) {
    console.error('Error updating channel:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST: Bulk update channels with impressions and conversions from priority channels calculation
app.post('/api/channels/bulk-update-totals', async (req, res) => {
  try {
    const { updates } = req.body; // Array of { channel_id, totImpressions, totConversions }
    
    console.log('Bulk update request received:', { updatesCount: updates?.length || 0 });
    
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Updates array is required' });
    }
    
    const channels = db.collection('channels');
    let updatedCount = 0;
    let matchedCount = 0;
    const errors = [];
    
    for (const update of updates) {
      const { channel_id, totImpressions, totConversions } = update;
      
      if (!channel_id) {
        errors.push({ channel_id: 'missing', error: 'channel_id is required' });
        continue;
      }
      
      try {
        console.log(`Updating channel ${channel_id}: impressions=${totImpressions}, conversions=${totConversions}`);
        
        const result = await channels.updateOne(
          { channel_id: channel_id },
          { 
            $set: { 
              totImpressions: totImpressions || 0,
              totConversions: totConversions || 0,
              updatedAt: new Date()
            } 
          }
        );
        
        console.log(`Update result for ${channel_id}: matched=${result.matchedCount}, modified=${result.modifiedCount}`);
        
        if (result.matchedCount > 0) {
          matchedCount++;
          if (result.modifiedCount > 0) {
            updatedCount++;
          }
        } else {
          errors.push({ channel_id, error: 'Channel not found' });
        }
      } catch (err) {
        console.error(`Error updating channel ${channel_id}:`, err);
        errors.push({ channel_id, error: err.message });
      }
    }
    
    const response = {
      message: `Updated ${updatedCount} channel(s)`,
      updatedCount,
      matchedCount,
      total: updates.length,
      errors: errors.length > 0 ? errors : undefined
    };
    
    console.log('Bulk update completed:', response);
    
    res.status(200).json(response);
  } catch (err) {
    console.error('Error bulk updating channels:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// DELETE: Delete a channel
app.delete('/api/channels/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const channels = db.collection('channels');
    
    // Try to find by channel_id first, then by _id
    let query = { channel_id: id };
    let channel = await channels.findOne(query);
    
    if (!channel) {
      try {
        query = { _id: new ObjectId(id) };
        channel = await channels.findOne(query);
      } catch (e) {
        // Invalid ObjectId format
      }
    }
    
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    
    const result = await channels.deleteOne(query);
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    
    console.log(`Deleted channel: ${id}`);
    res.json({ message: 'Channel deleted successfully', channel_id: id });
  } catch (err) {
    console.error('Error deleting channel:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  // Handle multer errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        error: 'File too large', 
        details: 'Maximum file size is 5MB per file.' 
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ 
        error: 'Too many files', 
        details: 'Maximum 10 files allowed per request.' 
      });
    }
    if (err.code === 'LIMIT_FIELD_COUNT') {
      return res.status(400).json({ 
        error: 'Too many fields', 
        details: 'Request contains too many fields.' 
      });
    }
    if (err.code === 'LIMIT_PART_COUNT') {
      return res.status(400).json({ 
        error: 'Too many parts', 
        details: 'Request contains too many parts.' 
      });
    }
    return res.status(400).json({ 
      error: 'Upload error', 
      details: err.message 
    });
  }
  
  // Handle file filter errors
  if (err.message && (
    err.message.includes('Invalid file type') ||
    err.message.includes('Invalid file extension') ||
    err.message.includes('Invalid filename') ||
    err.message.includes('Only image files')
  )) {
    return res.status(400).json({ 
      error: 'File validation failed', 
      details: err.message 
    });
  }
  
  // Handle rate limit errors
  if (err.status === 429) {
    return res.status(429).json({ 
      error: 'Too many requests', 
      details: err.message || 'Please try again later.' 
    });
  }
  
  // Generic error handling
  if (req.path.startsWith('/api/')) {
    res.status(500).json({ 
      error: 'Server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } else {
    res.status(500).send('Server error');
  }
});

// 404 handler
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Not found' });
  } else {
    res.status(404).sendFile(path.join(__dirname, 'index.html'));
  }
});

async function setupDatabase() {
  const client = new MongoClient(uri, {
    ssl: true,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    tlsAllowInvalidCertificates: false,
    tlsAllowInvalidHostnames: false,
  });

  let retries = 3;
  while (retries > 0) {
    try {
      console.log(`Attempting to connect to MongoDB (Retries left: ${retries})...`);
      await client.connect();
      console.log('Connected to MongoDB');
      db = client.db('event_campaign_db');
      
      // Initialize GridFS bucket for image storage
      gridFSBucket = new GridFSBucket(db, { bucketName: 'images' });
      console.log('GridFS bucket initialized for image storage');
      
      const campaigns = db.collection('campaigns');
      await campaigns.createIndex({ campaignId: 1 }, { unique: true });
      console.log('Unique index on campaignId created');
      const tagCounters = db.collection('tagCounters');
      await tagCounters.createIndex({ prefix: 1 }, { unique: true });
      console.log('Unique index on tagCounters created');
      const channels = db.collection('channels');
      await channels.createIndex({ channel_id: 1 }, { unique: true });
      console.log('Unique index on channels.channel_id created');
      const employees = db.collection('employees');
      await employees.createIndex({ employee_id: 1 }, { unique: true });
      console.log('Unique index on employees.employee_id created');
      return;
    } catch (err) {
      console.error(`MongoDB connection failed (Attempt ${4 - retries}):`, err.message);
      retries -= 1;
      if (retries === 0) {
        console.error('All MongoDB connection retries failed');
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// Helper function to find campaign by ObjectId (standardized identifier)
async function findCampaignByObjectId(objectIdString) {
  const campaigns = db.collection('campaigns');
  
  // Validate ObjectId format
  if (!ObjectId.isValid(objectIdString)) {
    throw new Error('Invalid ObjectId format');
  }
  
  const objectId = new ObjectId(objectIdString);
  return await campaigns.findOne({ _id: objectId });
}

// Generate Marketing ID using a persistent counter (6-digit format: MK_000001, MK_000002, etc.)
async function getNextCampaignId() {
  try {
    const counters = db.collection('counters');
    console.log('Getting next marketing ID from persistent counter...');
    
    // Atomically increment the counter and get the new value
    const result = await counters.findOneAndUpdate(
      { _id: 'campaignId' },
      { $inc: { lastNumber: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    
    console.log('findOneAndUpdate result:', JSON.stringify(result, null, 2));
    
    // Handle different MongoDB driver versions
    let nextId;
    if (result && result.value) {
      nextId = result.value.lastNumber;
      console.log('Using result.value.lastNumber:', nextId);
    } else if (result && result.lastNumber) {
      nextId = result.lastNumber;
      console.log('Using result.lastNumber:', nextId);
    } else {
      // Fallback: get the current value
      console.log('Using fallback method...');
      const currentDoc = await counters.findOne({ _id: 'campaignId' });
      nextId = currentDoc ? currentDoc.lastNumber : 1;
      console.log('Fallback nextId:', nextId);
    }
    
    const campaignId = `MK_${nextId.toString().padStart(6, '0')}`;
    console.log(`Generated marketing ID: ${campaignId} (6-digit format)`);
    return campaignId;
  } catch (err) {
    console.error('Error generating persistent campaignId:', err);
    throw err;
  }
}

// Generate Channel ID using a persistent counter (6-digit format: CH_000001, CH_000002, etc.)
async function getNextChannelId() {
  try {
    const counters = db.collection('counters');
    console.log('Getting next channel ID from persistent counter...');
    
    // Atomically increment the counter and get the new value
    const result = await counters.findOneAndUpdate(
      { _id: 'channelId' },
      { $inc: { lastNumber: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    
    // Handle different MongoDB driver versions
    let nextId;
    if (result && result.value) {
      nextId = result.value.lastNumber;
    } else if (result && result.lastNumber) {
      nextId = result.lastNumber;
    } else {
      // Fallback: get the current value
      const currentDoc = await counters.findOne({ _id: 'channelId' });
      nextId = currentDoc ? currentDoc.lastNumber : 1;
    }
    
    const channelId = `CH_${nextId.toString().padStart(6, '0')}`;
    console.log(`Generated channel ID: ${channelId} (6-digit format)`);
    return channelId;
  } catch (err) {
    console.error('Error generating persistent channelId:', err);
    throw err;
  }
}

// Generate Employee ID using a persistent counter (6-digit format: EMP_000001, EMP_000002, etc.)
async function getNextEmployeeId() {
  try {
    const counters = db.collection('counters');
    console.log('Getting next employee ID from persistent counter...');
    
    // Atomically increment the counter and get the new value
    const result = await counters.findOneAndUpdate(
      { _id: 'employeeId' },
      { $inc: { lastNumber: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    
    // Handle different MongoDB driver versions
    let nextId;
    if (result && result.value) {
      nextId = result.value.lastNumber;
    } else if (result && result.lastNumber) {
      nextId = result.lastNumber;
    } else {
      // Fallback: get the current value
      const currentDoc = await counters.findOne({ _id: 'employeeId' });
      nextId = currentDoc ? currentDoc.lastNumber : 1;
    }
    
    const employeeId = `EMP_${nextId.toString().padStart(6, '0')}`;
    console.log(`Generated employee ID: ${employeeId} (6-digit format)`);
    return employeeId;
  } catch (err) {
    console.error('Error generating persistent employeeId:', err);
    throw err;
  }
}

// Initialize database and start server
async function startServer() {
  try {
    await setupDatabase();
    app.locals.db = db;

    // Start server after DB connection
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log('Application startup completed');
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}


startServer();