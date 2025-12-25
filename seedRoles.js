// Seed script to initialize roles collection with admin role
const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

const uri = process.env.MONGO_URI;
const dbName = 'event_campaign_db'; // Same database as your main application

async function seedRoles() {
  const client = new MongoClient(uri, {
    ssl: true,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    tlsAllowInvalidCertificates: false,
    tlsAllowInvalidHostnames: false,
  });
  
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB Atlas');
    
    const db = client.db(dbName);
    const rolesCollection = db.collection('roles');
    
    // Check if admin role already exists
    const existingAdmin = await rolesCollection.findOne({ name: 'admin' });
    if (existingAdmin) {
      console.log('ℹ️  Admin role already exists, skipping...');
      console.log('📋 Existing admin role ID:', existingAdmin._id);
      return;
    }
    
    // Create admin role with all permissions
    const adminRole = {
      name: 'admin',
      description: 'Full access - Can create, edit, delete campaigns, manage users, view reports, and export data',
      permissions: {
        create_campaigns: true,
        edit_campaigns: true,
        delete_campaigns: true,
        view_campaigns: true,
        view_reports: true,
        export_data: true,
        manage_users: true,
        manage_roles: true,
        manage_channels: true
      },
      created_at: new Date(),
      updated_at: new Date()
    };
    
    const result = await rolesCollection.insertOne(adminRole);
    console.log('✅ Admin role created successfully with ID:', result.insertedId);
    console.log('📋 Admin role permissions:');
    console.log(JSON.stringify(adminRole.permissions, null, 2));
    
    // Display available permissions for reference
    console.log('\n📝 Available permissions for creating viewer and editor roles:');
    const availablePermissions = [
      'create_campaigns',
      'edit_campaigns', 
      'delete_campaigns',
      'view_campaigns',
      'view_reports',
      'export_data',
      'manage_users',
      'manage_roles',
      'manage_channels'
    ];
    
    availablePermissions.forEach(permission => {
      console.log(`  - ${permission}`);
    });
    
    console.log('\n🎯 Next steps:');
    console.log('1. Create "viewer" role with view_campaigns: true, view_reports: true');
    console.log('2. Create "editor" role with create_campaigns: true, edit_campaigns: true, view_reports: true, export_data: true, manage_channels: true');
    console.log('3. Assign roles to users as needed');
    
    // Show MongoDB commands for manual creation
    console.log('\n🔧 MongoDB commands for manual role creation:');
    console.log('// Connect to your MongoDB Atlas database');
    console.log('// Use the same connection string as your application');
    console.log('');
    console.log('// Create viewer role:');
    console.log(`db.roles.insertOne({
  name: 'viewer',
  description: 'View only - Can view campaigns and reports, no editing permissions',
  permissions: {
    create_campaigns: false,
    edit_campaigns: false,
    delete_campaigns: false,
    view_campaigns: true,
    view_reports: true,
    export_data: false,
    manage_users: false,
    manage_roles: false,
    manage_channels: false
  },
  created_at: new Date(),
  updated_at: new Date()
});`);
    console.log('');
    console.log('// Create editor role:');
    console.log(`db.roles.insertOne({
  name: 'editor',
  description: 'Edit access - Can create and edit campaigns, view reports, and export data',
  permissions: {
    create_campaigns: true,
    edit_campaigns: true,
    delete_campaigns: false,
    view_campaigns: true,
    view_reports: true,
    export_data: true,
    manage_users: false,
    manage_roles: false,
    manage_channels: true
  },
  created_at: new Date(),
  updated_at: new Date()
});`);
    
  } catch (error) {
    console.error('❌ Error seeding roles:', error);
  } finally {
    await client.close();
    console.log('🔌 Disconnected from MongoDB Atlas');
  }
}

// Run the seed function
seedRoles().catch(console.error); 