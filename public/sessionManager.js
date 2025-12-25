// Session Manager for Role-Based Access Control
class SessionManager {
  constructor() {
    this.currentUser = null;
    this.userPermissions = null;
    this.isAuthenticated = false;
  }

  // Initialize session from localStorage or server
  async initialize() {
    const token = localStorage.getItem('authToken');
    if (token) {
      try {
        const response = await fetch('/api/auth/me', {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        
        if (response.ok) {
          const userData = await response.json();
          await this.setCurrentUser(userData);
        } else {
          this.logout();
        }
      } catch (error) {
        console.error('Session initialization failed:', error);
        this.logout();
      }
    } else {
      // Show login form on initial load when no token exists
      this.showLoginForm();
    }
  }

  // Login user
  async login(username, password) {
    try {
      // For demo purposes, create a simple authentication
      // In production, this would be a proper API call
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password })
      });

      console.log('Server response status:', response.status);
      
      if (response.ok) {
        const data = await response.json();
        localStorage.setItem('authToken', data.token);
        await this.setCurrentUser(data.user);
        return { success: true };
      } else {
        const error = await response.json();
        const errorMessage = error.error || 'Invalid credentials';
        return { success: false, error: errorMessage };
      }
    } catch (error) {
      console.error('Login failed:', error);
      return { success: false, error: 'Login failed' };
    }
  }

  // Set current user and fetch permissions
  async setCurrentUser(userData) {
    this.currentUser = userData;
    this.isAuthenticated = true;
    
    // Fetch user permissions from roles
    if (userData.roles && userData.roles.length > 0) {
      await this.fetchUserPermissions(userData.roles);
    } else {
      this.userPermissions = this.getDefaultPermissions();
    }
    
    // Store in localStorage
    localStorage.setItem('currentUser', JSON.stringify(userData));
    
    // Hide login form and show main content
    this.hideLoginForm();
    
    // Trigger UI updates
    this.updateUI();
    
    // Show campaigns table after successful login
    if (typeof showSection === 'function') {
      showSection('campaigns-table');
    }
  }

  // Fetch user permissions from roles
  async fetchUserPermissions(roleIds) {
    try {
      const response = await fetch('/api/users/permissions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ roleIds })
      });
      
      if (response.ok) {
        this.userPermissions = await response.json();
      } else {
        this.userPermissions = this.getDefaultPermissions();
      }
    } catch (error) {
      console.error('Failed to fetch permissions:', error);
      this.userPermissions = this.getDefaultPermissions();
    }
  }

  // Get default permissions (viewer level)
  getDefaultPermissions() {
    return {
      create_campaigns: false,
      edit_campaigns: false,
      delete_campaigns: false,
      view_campaigns: true,
      view_reports: true,
      export_data: false,
      manage_users: false,
      manage_roles: false,
      manage_channels: false
    };
  }

  // Check if user has specific permission
  hasPermission(permission) {
    if (!this.isAuthenticated || !this.userPermissions) {
      return false;
    }
    return this.userPermissions[permission] === true;
  }

  // Permission checking methods
  canCreateCampaigns() {
    return this.hasPermission('create_campaigns');
  }

  canEditCampaigns() {
    return this.hasPermission('edit_campaigns');
  }

  canDeleteCampaigns() {
    return this.hasPermission('delete_campaigns');
  }

  canViewCampaigns() {
    return this.hasPermission('view_campaigns');
  }

  canViewReports() {
    return this.hasPermission('view_reports');
  }

  canExportData() {
    return this.hasPermission('export_data');
  }

  canManageUsers() {
    return this.hasPermission('manage_users');
  }

  canManageRoles() {
    return this.hasPermission('manage_roles');
  }

  canManageChannels() {
    return this.hasPermission('manage_channels');
  }

  // Update UI based on permissions
  updateUI() {
    this.updateNavigation();
    this.updateCampaignActions();
    this.updateUserManagement();
    this.updateRoleManagement();
  }

  // Update navigation visibility
  updateNavigation() {
    // Campaign management
    const campaignNav = document.getElementById('campaigns-nav');
    if (campaignNav) {
      campaignNav.style.display = this.canViewCampaigns() ? 'block' : 'none';
    }

    // User management
    const userNav = document.getElementById('user-manager-nav');
    if (userNav) {
      userNav.style.display = this.canManageUsers() ? 'block' : 'none';
    }

    // Reports
    const reportsNav = document.getElementById('reports-nav');
    if (reportsNav) {
      reportsNav.style.display = this.canViewReports() ? 'block' : 'none';
    }
  }

  // Update campaign action buttons
  updateCampaignActions() {
    // Create campaign button
    const createCampaignBtn = document.getElementById('create-campaign-btn');
    if (createCampaignBtn) {
      createCampaignBtn.style.display = this.canCreateCampaigns() ? 'inline-block' : 'none';
    }

    // Edit campaign buttons
    const editButtons = document.querySelectorAll('.edit-campaign-btn');
    editButtons.forEach(btn => {
      btn.style.display = this.canEditCampaigns() ? 'inline-block' : 'none';
    });

    // Delete campaign buttons (menu button and table buttons)
    const deleteButtons = document.querySelectorAll('.delete-campaign-btn');
    deleteButtons.forEach(btn => {
      btn.style.display = this.canDeleteCampaigns() ? 'inline-block' : 'none';
    });

    // Generate tags buttons - removed since tags are now auto-generated
  }

  // Update user management visibility
  updateUserManagement() {
    // Don't automatically show/hide the user-manager section
    // Let the showSection() function handle visibility based on user actions
    
    // User management buttons
    const addUserBtn = document.getElementById('addUserBtn');
    if (addUserBtn) {
      addUserBtn.style.display = this.canManageUsers() ? 'inline-block' : 'none';
    }

    const editUserButtons = document.querySelectorAll('.edit-user-btn');
    editUserButtons.forEach(btn => {
      btn.style.display = this.canManageUsers() ? 'inline-block' : 'none';
    });

    const deleteUserButtons = document.querySelectorAll('.delete-user-btn');
    deleteUserButtons.forEach(btn => {
      btn.style.display = this.canManageUsers() ? 'inline-block' : 'none';
    });
  }

  // Update role management visibility
  updateRoleManagement() {
    // Don't automatically show/hide the role section
    // Let the showSection() function handle visibility based on user actions
    
    // Role management buttons
    const addRoleBtn = document.getElementById('addRoleBtn');
    if (addRoleBtn) {
      addRoleBtn.style.display = this.canManageRoles() ? 'inline-block' : 'none';
    }

    const editRoleButtons = document.querySelectorAll('.edit-role-btn');
    editRoleButtons.forEach(btn => {
      btn.style.display = this.canManageRoles() ? 'inline-block' : 'none';
    });

    const deleteRoleButtons = document.querySelectorAll('.delete-role-btn');
    deleteRoleButtons.forEach(btn => {
      btn.style.display = this.canManageRoles() ? 'inline-block' : 'none';
    });
  }

  // Logout user
  logout() {
    this.currentUser = null;
    this.userPermissions = null;
    this.isAuthenticated = false;
    
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    
    // Clear login form fields
    const usernameField = document.getElementById('username');
    const passwordField = document.getElementById('password');
    const errorDiv = document.getElementById('loginError');
    
    if (usernameField) usernameField.value = '';
    if (passwordField) passwordField.value = '';
    if (errorDiv) errorDiv.classList.add('hidden');
    
    // Redirect to login or show login form
    this.showLoginForm();
  }

  // Show login form
  showLoginForm() {
    // Hide main content
    const mainContent = document.getElementById('main-content');
    if (mainContent) {
      mainContent.style.display = 'none';
    }

    // Show login form as full screen
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.style.display = 'block';
    }

    // Login form handler is now managed in the HTML file
  }

  // Hide login form
  hideLoginForm() {
    // Hide login form
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.style.display = 'none';
    }

    // Show main content
    const mainContent = document.getElementById('main-content');
    if (mainContent) {
      mainContent.style.display = 'flex';
    }
  }

  // Get current user info
  getCurrentUser() {
    return this.currentUser;
  }

  // Get user permissions
  getUserPermissions() {
    return this.userPermissions;
  }

  // Check if user is authenticated
  isUserAuthenticated() {
    return this.isAuthenticated;
  }
}

// Global session manager instance
window.sessionManager = new SessionManager();

// Initialize session when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
  await window.sessionManager.initialize();
});

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SessionManager;
} 