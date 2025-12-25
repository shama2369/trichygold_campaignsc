// Database-driven Roles Manager for campaign management system
const { ObjectId } = require('mongodb');

class RolesManager {
  // Default permissions for campaign management
  static getDefaultPermissions() {
    return {
      create_campaigns: false,
      edit_campaigns: false,
      delete_campaigns: false,
      view_campaigns: true,
      view_reports: false,
      export_data: false,
      manage_users: false,
      manage_roles: false,
      manage_channels: false
    };
  }

  // Get all roles from database
  static async getAllRoles(db) {
    try {
      const roles = await db.collection('roles').find({}).toArray();
      return roles;
    } catch (error) {
      console.error('Error fetching roles:', error);
      return [];
    }
  }

  // Get role by ID
  static async getRoleById(db, roleId) {
    try {
      const role = await db.collection('roles').findOne({ _id: new ObjectId(roleId) });
      return role;
    } catch (error) {
      console.error('Error fetching role:', error);
      return null;
  }
  }

  // Get role by name
  static async getRoleByName(db, name) {
    try {
      const role = await db.collection('roles').findOne({ name: name });
      return role;
    } catch (error) {
      console.error('Error fetching role by name:', error);
      return null;
    }
  }

  // Create new role
  static async createRole(db, roleData) {
    try {
      const { name, description, permissions } = roleData;
      
      // Check if role already exists
      const existingRole = await this.getRoleByName(db, name);
      if (existingRole) {
        throw new Error('Role with this name already exists');
      }

      const newRole = {
        name: name,
        description: description || '',
        permissions: permissions || this.getDefaultPermissions(),
        created_at: new Date(),
        updated_at: new Date()
      };

      const result = await db.collection('roles').insertOne(newRole);
      return { ...newRole, _id: result.insertedId };
    } catch (error) {
      console.error('Error creating role:', error);
      throw error;
    }
  }

  // Update role
  static async updateRole(db, roleId, roleData) {
    try {
      const { name, description, permissions } = roleData;
      
      // Check if name is being changed and if it conflicts
      if (name) {
        const existingRole = await this.getRoleByName(db, name);
        if (existingRole && existingRole._id.toString() !== roleId) {
          throw new Error('Role with this name already exists');
        }
      }

      const updateData = {
        updated_at: new Date()
      };

      if (name) updateData.name = name;
      if (description !== undefined) updateData.description = description;
      if (permissions) updateData.permissions = permissions;

      const result = await db.collection('roles').updateOne(
        { _id: new ObjectId(roleId) },
        { $set: updateData }
      );

      if (result.matchedCount === 0) {
        throw new Error('Role not found');
    }

      return await this.getRoleById(db, roleId);
    } catch (error) {
      console.error('Error updating role:', error);
      throw error;
  }
  }

  // Delete role
  static async deleteRole(db, roleId) {
    try {
      // Check if role is being used by any users
      const usersWithRole = await db.collection('users').findOne({ roles: roleId });
      if (usersWithRole) {
        throw new Error('Cannot delete role: It is assigned to one or more users');
      }

      const result = await db.collection('roles').deleteOne({ _id: new ObjectId(roleId) });
      
      if (result.deletedCount === 0) {
        throw new Error('Role not found');
      }

      return true;
    } catch (error) {
      console.error('Error deleting role:', error);
      throw error;
    }
  }

  // Check if user has specific permission
  static async hasPermission(db, userId, permission) {
    try {
      const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
      if (!user || !user.roles || user.roles.length === 0) {
        return false;
      }

      // Get all user roles
      const userRoles = await db.collection('roles').find({
        _id: { $in: user.roles.map(roleId => new ObjectId(roleId)) }
      }).toArray();

      // Check if any role has the permission
      return userRoles.some(role => 
        role.permissions && role.permissions[permission] === true
      );
    } catch (error) {
      console.error('Error checking permission:', error);
    return false;
    }
  }

  // Get user permissions from user ID
  static async getUserPermissions(db, userId) {
    try {
      const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
      if (!user || !user.roles || user.roles.length === 0) {
        return this.getDefaultPermissions();
      }

      // Get all user roles
      const userRoles = await db.collection('roles').find({
        _id: { $in: user.roles.map(roleId => new ObjectId(roleId)) }
      }).toArray();

      // Combine permissions from all roles (OR logic)
      const combinedPermissions = { ...this.getDefaultPermissions() };
      
      userRoles.forEach(role => {
        if (role.permissions) {
          Object.keys(role.permissions).forEach(permission => {
            if (role.permissions[permission] === true) {
              combinedPermissions[permission] = true;
            }
          });
        }
      });

      return combinedPermissions;
    } catch (error) {
      console.error('Error getting user permissions:', error);
      return this.getDefaultPermissions();
    }
  }

  // Get permissions from role IDs
  static async getPermissionsFromRoleIds(db, roleIds) {
    try {
      if (!roleIds || roleIds.length === 0) {
        return this.getDefaultPermissions();
      }

      // Get all roles
      const roles = await db.collection('roles').find({
        _id: { $in: roleIds.map(roleId => new ObjectId(roleId)) }
      }).toArray();

      // Combine permissions from all roles (OR logic)
      const combinedPermissions = { ...this.getDefaultPermissions() };
      
      roles.forEach(role => {
        if (role.permissions) {
          Object.keys(role.permissions).forEach(permission => {
            if (role.permissions[permission] === true) {
              combinedPermissions[permission] = true;
            }
          });
        }
      });

      return combinedPermissions;
    } catch (error) {
      console.error('Error getting permissions from role IDs:', error);
      return this.getDefaultPermissions();
    }
  }

  // Initialize default roles if they don't exist
  static async initializeDefaultRoles(db) {
    try {
      const defaultRoles = [
        {
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
          }
        },
        {
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
            manage_channels: false
          }
        },
        {
          name: 'viewer',
          description: 'View only - Can view campaigns and reports, no editing or administrative permissions',
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
          }
        }
      ];

      for (const roleData of defaultRoles) {
        const existingRole = await this.getRoleByName(db, roleData.name);
        if (!existingRole) {
          await this.createRole(db, roleData);
          console.log(`Created default role: ${roleData.name}`);
        }
      }
    } catch (error) {
      console.error('Error initializing default roles:', error);
    }
  }

  // Get all available permissions (for UI)
  static getAvailablePermissions() {
    return [
      { key: 'create_campaigns', label: 'Create Campaigns' },
      { key: 'edit_campaigns', label: 'Edit Campaigns' },
      { key: 'delete_campaigns', label: 'Delete Campaigns' },
      { key: 'view_campaigns', label: 'View Campaigns' },
      { key: 'view_reports', label: 'View Reports' },
      { key: 'export_data', label: 'Export Data' },
      { key: 'manage_users', label: 'Manage Users' },
      { key: 'manage_roles', label: 'Manage Roles' },
      { key: 'manage_channels', label: 'Manage Channels' }
    ];
  }
}

module.exports = RolesManager;
