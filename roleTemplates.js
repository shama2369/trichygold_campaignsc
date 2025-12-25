// Role templates for campaign management system
// Use these as reference when creating viewer and editor roles

// VIEWER ROLE TEMPLATE
const viewerRole = {
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
};

// EDITOR ROLE TEMPLATE
const editorRole = {
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
};

// ADMIN ROLE TEMPLATE (for reference)
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

// MongoDB commands to create these roles:

/*
// To create viewer role:
db.roles.insertOne({
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
});

// To create editor role:
db.roles.insertOne({
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
});
*/

module.exports = {
  viewerRole,
  editorRole,
  adminRole
}; 