inconst { MongoClient } = require('mongodb');

const uri = "mongodb://localhost:27017/trichygold";

async function checkCampaignData() {
  let client;
  try {
    console.log('Connecting to MongoDB...');
    client = new MongoClient(uri);
    await client.connect();
    console.log('Connected to MongoDB');

    const db = client.db();
    const campaigns = db.collection('campaigns');
    
    // Get all campaigns
    const allCampaigns = await campaigns.find({}).toArray();
    console.log(`\nTotal campaigns found: ${allCampaigns.length}`);
    
    if (allCampaigns.length === 0) {
      console.log('No campaigns found in database');
      return;
    }
    
    // Examine each campaign
    allCampaigns.forEach((campaign, index) => {
      console.log(`\n--- Campaign ${index + 1} ---`);
      console.log(`Campaign ID: ${campaign.campaignId}`);
      console.log(`Name: ${campaign.name}`);
      console.log(`Channels count: ${campaign.channels?.length || 0}`);
      
      if (campaign.channels && Array.isArray(campaign.channels)) {
        campaign.channels.forEach((channel, chIndex) => {
          console.log(`  Channel ${chIndex + 1}:`);
          console.log(`    Type: ${channel.type}`);
          console.log(`    Platform: ${channel.platform || 'N/A'}`);
          console.log(`    Ad Name: ${channel.adName || 'N/A'}`);
          console.log(`    Impressions: ${channel.impressions || 'N/A'}`);
          console.log(`    Cost: ${channel.cost || 'N/A'}`);
          
          // Check if impressions field exists and its type
          if (channel.hasOwnProperty('impressions')) {
            console.log(`    Impressions field exists: YES, Type: ${typeof channel.impressions}, Value: ${channel.impressions}`);
          } else {
            console.log(`    Impressions field exists: NO`);
          }
        });
      } else {
        console.log('  No channels found or channels is not an array');
      }
    });
    
    // Check if any campaigns have impressions > 0
    const campaignsWithImpressions = allCampaigns.filter(campaign => {
      if (campaign.channels && Array.isArray(campaign.channels)) {
        return campaign.channels.some(channel => (channel.impressions || 0) > 0);
      }
      return false;
    });
    
    console.log(`\n=== SUMMARY ===`);
    console.log(`Campaigns with impressions > 0: ${campaignsWithImpressions.length}`);
    
    if (campaignsWithImpressions.length > 0) {
      console.log('These campaigns have impressions:');
      campaignsWithImpressions.forEach(campaign => {
        console.log(`- ${campaign.campaignId}: ${campaign.name}`);
      });
    } else {
      console.log('No campaigns have impressions > 0');
    }
    
  } catch (error) {
    console.error('Error checking campaign data:', error);
  } finally {
    if (client) {
      await client.close();
      console.log('\nDisconnected from MongoDB');
    }
  }
}

checkCampaignData(); 