// Express routes for user CRUD with database-driven roles
const express = require('express');
const { ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const RolesManager = require('../models/rolesManager');

const router = express.Router();

// Initialize default roles on startup
router.use(async (req, res, next) => {
  if (req.app.locals.db) {
    await RolesManager.initializeDefaultRoles(req.app.locals.db);
  }
  next();
});

// CREATE user
router.post('/', async (req, res) => {
  try {
    const { username, password, email, roles } = req.body;
    if (!username || !password || !email) {
      return res.status(400).json({ error: 'username, password, and email are required' });
    }
    
    // Hash the password before storing
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    // Validate roles exist in database
    if (roles && Array.isArray(roles)) {
      const db = req.app.locals.db;
      for (const roleId of roles) {
        const role = await RolesManager.getRoleById(db, roleId);
        if (!role) {
          return res.status(400).json({ error: `Role with ID ${roleId} not found` });
    }
      }
    }

    const user = new User({ username, password: hashedPassword, email, roles: roles || [] });
    const db = req.app.locals.db;
    await db.collection('users').insertOne(user);
    // Exclude password from response
    const userWithoutPassword = { ...user };
    delete userWithoutPassword.password;
    res.status(201).json({ message: 'User created', user: userWithoutPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all users
router.get('/', async (req, res) => {
  console.log('Received GET request for all users (/api/users)');
  try {
    const db = req.app.locals.db;
    const users = await db.collection('users').find({}).toArray();
    
    // Populate role names for each user
    const usersWithRoleNames = await Promise.all(users.map(async (user) => {
      if (user.roles && user.roles.length > 0) {
        try {
          const userRoles = await db.collection('roles').find({
            _id: { $in: user.roles.map(roleId => new ObjectId(roleId)) }
          }).toArray();
          return {
            ...user,
            roleNames: userRoles.map(role => role.name)
          };
        } catch (error) {
          console.error('Error converting role IDs:', error);
          return { ...user, roleNames: ['Error loading roles'] };
        }
      }
      return { ...user, roleNames: [] };
    }));
    
    // Exclude passwords from all users before sending response
    const usersWithoutPasswords = usersWithRoleNames.map(({ password, ...user }) => user);
    res.json(usersWithoutPasswords);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET user by id
router.get('/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.params.id) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Exclude password from response
    const userWithoutPassword = { ...user };
    delete userWithoutPassword.password;
    res.json(userWithoutPassword);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE user roles
router.put('/:id/roles', async (req, res) => {
  try {
    const { roles } = req.body;
    if (!Array.isArray(roles)) {
      return res.status(400).json({ error: 'Roles must be an array' });
    }

    // Validate roles exist in database
    const db = req.app.locals.db;
    for (const roleId of roles) {
      const role = await RolesManager.getRoleById(db, roleId);
      if (!role) {
        return res.status(400).json({ error: `Role with ID ${roleId} not found` });
      }
    }

    const result = await db.collection('users').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { roles } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'Roles updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE user
router.delete('/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const result = await db.collection('users').deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROLE MANAGEMENT ENDPOINTS

// GET all roles
router.get('/roles/all', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const roles = await RolesManager.getAllRoles(db);
    res.json(roles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET available permissions
router.get('/roles/permissions/available', (req, res) => {
  try {
    const permissions = RolesManager.getAvailablePermissions();
    res.json(permissions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET role descriptions (for dropdowns and lists)
router.get('/roles/descriptions', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const roles = await RolesManager.getAllRoles(db);
    const roleDescriptions = roles.map(role => ({
      role: role.name,
      description: role.description || 'No description available'
    }));
    res.json(roleDescriptions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST new role
router.post('/roles', async (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Role name is required' });
    }

    const db = req.app.locals.db;
    const newRole = await RolesManager.createRole(db, { name, description, permissions });
    res.status(201).json({ message: 'Role created', role: newRole });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST get user permissions from role IDs
router.post('/permissions', async (req, res) => {
  try {
    const { roleIds } = req.body;
    if (!Array.isArray(roleIds)) {
      return res.status(400).json({ error: 'Role IDs must be an array' });
    }

    const db = req.app.locals.db;
    const permissions = await RolesManager.getPermissionsFromRoleIds(db, roleIds);
    res.json(permissions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update role
router.put('/roles/:id', async (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    const db = req.app.locals.db;
    const updatedRole = await RolesManager.updateRole(db, req.params.id, { name, description, permissions });
    res.json({ message: 'Role updated', role: updatedRole });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE role
router.delete('/roles/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    await RolesManager.deleteRole(db, req.params.id);
    res.json({ message: 'Role deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET role by ID (must be last to avoid conflicts)
router.get('/roles/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const role = await RolesManager.getRoleById(db, req.params.id);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    res.json(role);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PERMISSION CHECKING ENDPOINTS

// Check if user has specific permission
router.get('/permissions/:userId/:permission', async (req, res) => {
  try {
    const { userId, permission } = req.params;
    const db = req.app.locals.db;
    const hasPermission = await RolesManager.hasPermission(db, userId, permission);
    res.json({ hasPermission });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all user permissions
router.get('/permissions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = req.app.locals.db;
    const permissions = await RolesManager.getUserPermissions(db, userId);
    res.json(permissions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
