const { MongoClient } = require('mongodb');
require('dotenv').config();

async function checkGridFS() {
  const client = new MongoClient(process.env.MONGO_URI, {
    ssl: true,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db('event_campaign_db');
    
    // Check for GridFS collections
    const collections = await db.listCollections().toArray();
    console.log('\n=== All Collections ===');
    collections.forEach(col => {
      console.log(`- ${col.name}`);
    });
    
    // Check images.files collection
    const filesCollection = db.collection('images.files');
    const fileCount = await filesCollection.countDocuments();
    console.log(`\n=== GridFS Files Collection ===`);
    console.log(`images.files count: ${fileCount}`);
    
    if (fileCount > 0) {
      const files = await filesCollection.find({}).limit(5).toArray();
      console.log('\nSample files:');
      files.forEach(file => {
        console.log(`  - ${file.filename} (${file.length} bytes, ${file.contentType})`);
      });
    }
    
    // Check images.chunks collection
    const chunksCollection = db.collection('images.chunks');
    const chunkCount = await chunksCollection.countDocuments();
    console.log(`\n=== GridFS Chunks Collection ===`);
    console.log(`images.chunks count: ${chunkCount}`);
    
    // Check campaigns with images
    const campaigns = db.collection('campaigns');
    const campaignsWithImages = await campaigns.find({ 
      images: { $exists: true, $ne: [] } 
    }).toArray();
    
    console.log(`\n=== Campaigns with Images ===`);
    console.log(`Total campaigns with images: ${campaignsWithImages.length}`);
    campaignsWithImages.forEach(campaign => {
      console.log(`  - Campaign ID: ${campaign.campaignId}`);
      console.log(`    Images: ${JSON.stringify(campaign.images)}`);
    });
    
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.close();
    console.log('\nConnection closed');
  }
}

checkGridFS();
