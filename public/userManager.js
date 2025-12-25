// User and Role Manager UI logic
const apiBase = '/api/users';

// Global variable to store current user roles (for permission checking)
let currentUserRoles = [];

async function fetchUsers() {
  const res = await fetch(apiBase);
  return res.json();
}

async function fetchRoles() {
  const res = await fetch(apiBase + '/roles/all');
  return res.json();
}

async function fetchRoleDescriptions() {
  const res = await fetch(apiBase + '/roles/descriptions');
  return res.json();
}

async function createUser(user) {
  const res = await fetch(apiBase, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user)
  });
  return res.json();
}

async function updateUserRoles(id, roles) {
  const res = await fetch(`${apiBase}/${id}/roles`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roles })
  });
  return res.json();
}

async function deleteUser(id) {
  const res = await fetch(`${apiBase}/${id}`, { method: 'DELETE' });
  return res.json();
}

// Permission checking functions (frontend) - now using session manager
function hasPermission(permission) {
  return window.sessionManager ? window.sessionManager.hasPermission(permission) : false;
}

function canManageUsers() {
  return window.sessionManager ? window.sessionManager.canManageUsers() : false;
}

function canManageRoles() {
  return window.sessionManager ? window.sessionManager.canManageRoles() : false;
}

function canCreateCampaigns() {
  return window.sessionManager ? window.sessionManager.canCreateCampaigns() : false;
}

function canEditCampaigns() {
  return window.sessionManager ? window.sessionManager.canEditCampaigns() : false;
}

function canDeleteCampaigns() {
  return window.sessionManager ? window.sessionManager.canDeleteCampaigns() : false;
}

function canViewReports() {
  return window.sessionManager ? window.sessionManager.canViewReports() : false;
}

function canExportData() {
  return window.sessionManager ? window.sessionManager.canExportData() : false;
}

function canManageChannels() {
  return window.sessionManager ? window.sessionManager.canManageChannels() : false;
}

// UI rendering
async function renderUsersTable() {
  console.log('[DEBUG] renderUsersTable called');
  
  // Check if user manager section is visible before making API calls
  const userManagerSection = document.getElementById('user-manager');
  if (userManagerSection && userManagerSection.classList.contains('hidden')) {
    console.log('[DEBUG] User manager section is hidden, skipping API call');
    return;
  }
  
  try {
    const response = await fetch(apiBase);
    const users = await response.json();
    console.log('[DEBUG] Users fetched:', users);
    if (Array.isArray(users)) {
      const tbody = document.getElementById('users-table-body');
      console.log('[DEBUG] Table body found:', !!tbody);
      if (tbody) {
      tbody.innerHTML = '';
      users.forEach(user => {
        const tr = document.createElement('tr');
          const roleNames = user.roleNames && user.roleNames.length > 0 ? user.roleNames.join(', ') : 'No roles assigned';
        tr.innerHTML = `
          <td><b>${user.username}</b></td>
            <td>${user.email || 'No email'}</td>
            <td>${roleNames}</td>
          <td>
              <button style="background:#FFC107;color:#222;font-weight:bold;border:none;padding:6px 18px;border-radius:6px;cursor:pointer;margin-right:6px;" onclick="showEditRoles('${user._id}')">Edit Roles</button>
            <button style="background:#EF4444;color:white;font-weight:bold;border:none;padding:6px 18px;border-radius:6px;cursor:pointer;" onclick="removeUser('${user._id}')">Delete</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
        console.log('[DEBUG] Users table rendered successfully');
      } else {
        console.error('[DEBUG] users-table-body not found!');
      }
    } else {
      console.error('Expected an array of users');
    }
  } catch (error) {
    console.error('Failed to fetch users:', error);
  }
}

async function renderRolesOptions(select, selectedRoles = []) {
  try {
    const response = await fetch(apiBase + '/roles/all');
    const roles = await response.json();
    if (Array.isArray(roles)) {
      select.innerHTML = '';
      roles.forEach((role) => {
        const opt = document.createElement('option');
        opt.value = role._id; // Use role ID as value
        opt.textContent = `${role.name.charAt(0).toUpperCase() + role.name.slice(1)} - ${role.description || 'No description'}`;
        opt.title = role.description || 'No description'; // Tooltip on hover
        if (selectedRoles.includes(role._id)) opt.selected = true;
        select.appendChild(opt);
      });
    } else {
      console.error('Expected an array of roles');
    }
  } catch (error) {
    console.error('Failed to fetch roles:', error);
  }
}

async function showEditRoles(userId) {
  const users = await fetchUsers();
  const user = users.find(u => u._id === userId);
  if (!user) return alert('User not found');
  const modal = document.getElementById('editRolesModal');
  const select = document.getElementById('editRolesSelect');
  await renderRolesOptions(select, user.roles);
  modal.dataset.userid = userId;
  // Update modal title for editing user
  modal.querySelector('h3').textContent = 'Edit User Roles';
  modal.classList.remove('hidden');
}

// Make showEditRoles globally accessible
window.showEditRoles = showEditRoles;

async function saveEditedRoles() {
  const modal = document.getElementById('editRolesModal');
  const userId = modal.dataset.userid;
  const select = document.getElementById('editRolesSelect');
  const selectedRoles = Array.from(select.selectedOptions).map(opt => opt.value);
  await updateUserRoles(userId, selectedRoles);
  modal.classList.add('hidden');
  renderUsersTable();
}

// Make saveEditedRoles globally accessible
window.saveEditedRoles = saveEditedRoles;

function closeEditRolesModal() {
  document.getElementById('editRolesModal').classList.add('hidden');
}

// Make closeEditRolesModal globally accessible
window.closeEditRolesModal = closeEditRolesModal;

async function removeUser(id) {
  if (!confirm('Delete this user?')) return;
  await deleteUser(id);
  renderUsersTable();
  
  // Note: We don't refresh job assignment dropdowns when deleting users
  // because deleted users might have existing job assignments that need to be preserved
}

// Make removeUser globally accessible
window.removeUser = removeUser;

async function handleCreateUser(e) {
  e.preventDefault();
  const username = document.getElementById('newUserUsername').value.trim();
  const password = document.getElementById('newUserPassword').value;
  const email = document.getElementById('newUserEmail').value.trim();
  const select = document.getElementById('newUserRoles');
  const roles = Array.from(select.selectedOptions).map(opt => opt.value);
  if (!username || !password || !email) {
    alert('Username, password, and email are required');
    return;
  }
  const result = await createUser({ username, password, email, roles });
  if (result.error) {
    alert(result.error);
    return;
  }
  document.getElementById('createUserForm').reset();
  renderUsersTable();
  
  // Refresh job assignment dropdowns if the function exists
  if (typeof window.refreshJobAssignmentDropdowns === 'function') {
    window.refreshJobAssignmentDropdowns();
  }
}

document.addEventListener('DOMContentLoaded', function () {
  // Debug log for DOM loaded
  console.log('[DEBUG] DOMContentLoaded - Initializing User & Role Manager buttons');

  // Button and section references
  const addUserBtn = document.getElementById('addUserBtn');
  const manageRolesBtn = document.getElementById('manageRolesBtn');
  const toggleUserBtn = document.getElementById('toggleUserBtn');
  const toggleRoleBtn = document.getElementById('toggleRoleBtn');
  const cancelCreateUserBtn = document.getElementById('cancelCreateUserBtn');
  const editRolesCancelBtn = document.getElementById('editRolesCancelBtn');
  const editRolesSaveBtn = document.getElementById('editRolesSaveBtn');
  const createNewRoleBtn = document.getElementById('createNewRoleBtn');
  const backToRolesBtn = document.getElementById('backToRolesBtn');

  // Section references
  const userSection = document.getElementById('user-manager-user-section');
  const roleSection = document.getElementById('user-manager-role-section');
  const userTableSection = document.getElementById('user-table-section');
  const userCreateFormSection = document.getElementById('user-create-form-section');

  // Debug logs for all buttons
  console.log('[DEBUG] Button/Section presence:', {
    addUserBtn: !!addUserBtn,
    manageRolesBtn: !!manageRolesBtn,
    toggleUserBtn: !!toggleUserBtn,
    toggleRoleBtn: !!toggleRoleBtn,
    cancelCreateUserBtn: !!cancelCreateUserBtn,
    editRolesCancelBtn: !!editRolesCancelBtn,
    editRolesSaveBtn: !!editRolesSaveBtn,
    createNewRoleBtn: !!createNewRoleBtn,
    backToRolesBtn: !!backToRolesBtn,
    userSection: !!userSection,
    roleSection: !!roleSection,
    userTableSection: !!userTableSection,
    userCreateFormSection: !!userCreateFormSection
  });

  // Role manager logic
  async function fetchAndRenderRoles() {
    // Check if user manager section is visible before making API calls
    const userManagerSection = document.getElementById('user-manager');
    if (userManagerSection && userManagerSection.classList.contains('hidden')) {
      console.log('[DEBUG] User manager section is hidden, skipping roles API call');
      return;
    }
    
    try {
      const res = await fetch(apiBase + '/roles/all');
      const roles = await res.json();
      const rolesList = document.getElementById('roles-list');
      if (Array.isArray(roles)) {
        rolesList.innerHTML = roles.length === 0 ? '<li class="text-gray-500">No roles found.</li>' : '';
        roles.forEach((role) => {
          const li = document.createElement('li');
          li.className = 'py-4 px-4 border-b last:border-b-0';
          
          // Format permissions for display
          const activePermissions = Object.entries(role.permissions || {})
            .filter(([perm, value]) => value === true)
            .map(([perm]) => perm.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()))
            .join(', ');
          
          li.innerHTML = `
            <div class="font-semibold text-purple-700">${role.name.charAt(0).toUpperCase() + role.name.slice(1)}</div>
            <div class="text-sm text-gray-600 mt-1">${role.description || 'No description'}</div>
            <div class="text-xs text-green-600 mt-2">
              <strong>Permissions:</strong> ${activePermissions || 'None'}
            </div>
          `;
          rolesList.appendChild(li);
        });
      } else {
        rolesList.innerHTML = '<li class="text-red-500">Error loading roles</li>';
      }
    } catch (e) {
      console.error('Error fetching roles:', e);
      const rolesList = document.getElementById('roles-list');
      if (rolesList) rolesList.innerHTML = '<li class="text-red-500">Failed to fetch roles</li>';
    }
  }
  
  // Make fetchAndRenderRoles globally accessible
  window.fetchAndRenderRoles = fetchAndRenderRoles;
  
  async function fetchAndRenderRolesTable() {
    // Check if user manager section is visible before making API calls
    const userManagerSection = document.getElementById('user-manager');
    if (userManagerSection && userManagerSection.classList.contains('hidden')) {
      console.log('[DEBUG] User manager section is hidden, skipping roles API call');
      return;
    }
    
    try {
      const res = await fetch(apiBase + '/roles/all');
      const roles = await res.json();
      const tableBody = document.getElementById('roles-table-body');
      if (Array.isArray(roles)) {
        tableBody.innerHTML = roles.length === 0 ? '<tr><td colspan="3" class="text-center text-gray-500 py-4">No roles found.</td></tr>' : '';
        roles.forEach((role) => {
          const tr = document.createElement('tr');
          
          tr.innerHTML = `
            <td class="font-semibold text-purple-700">${role.name.charAt(0).toUpperCase() + role.name.slice(1)}</td>
            <td class="text-sm text-gray-600">${role.description || 'No description'}</td>
            <td class="flex gap-2">
              <button onclick="editRole('${role._id}')" class="btn-secondary px-3 py-1 rounded text-xs">Edit</button>
              <button onclick="deleteRole('${role._id}')" class="btn-primary px-3 py-1 rounded text-xs bg-red-500 hover:bg-red-600">Delete</button>
            </td>
          `;
          tableBody.appendChild(tr);
        });
      } else {
        tableBody.innerHTML = '<tr><td colspan="3" class="text-center text-red-500 py-4">Error loading roles</td></tr>';
      }
    } catch (e) {
      console.error('Error fetching roles:', e);
      const tableBody = document.getElementById('roles-table-body');
      if (tableBody) tableBody.innerHTML = '<tr><td colspan="3" class="text-center text-red-500 py-4">Failed to fetch roles</td></tr>';
    }
  }

  // Section navigation helpers
  function showUserSection() {
    userSection.classList.remove('hidden');
    roleSection.classList.add('hidden');
    const employeeSection = document.getElementById('user-manager-employee-section');
    if (employeeSection) employeeSection.classList.add('hidden');
    toggleUserBtn.classList.add('btn-primary');
    toggleUserBtn.classList.remove('btn-secondary');
    toggleRoleBtn.classList.add('btn-secondary');
    toggleRoleBtn.classList.remove('btn-primary');
    const toggleEmployeeBtn = document.getElementById('toggleEmployeeBtn');
    if (toggleEmployeeBtn) {
      toggleEmployeeBtn.classList.add('btn-secondary');
      toggleEmployeeBtn.classList.remove('btn-primary');
    }
    userTableSection.classList.remove('hidden');
    userCreateFormSection.classList.add('hidden');
    renderUsersTable();
    console.log('[DEBUG] Showing User section');
  }
  function showRoleSection() {
    userSection.classList.add('hidden');
    roleSection.classList.remove('hidden');
    const employeeSection = document.getElementById('user-manager-employee-section');
    if (employeeSection) employeeSection.classList.add('hidden');
    toggleUserBtn.classList.add('btn-secondary');
    toggleUserBtn.classList.remove('btn-primary');
    toggleRoleBtn.classList.add('btn-primary');
    toggleRoleBtn.classList.remove('btn-secondary');
    const toggleEmployeeBtn = document.getElementById('toggleEmployeeBtn');
    if (toggleEmployeeBtn) {
      toggleEmployeeBtn.classList.add('btn-secondary');
      toggleEmployeeBtn.classList.remove('btn-primary');
    }
    // Show roles table by default, hide create form
    document.getElementById('role-create-form-container').classList.add('hidden');
    document.getElementById('roles-table-container').classList.remove('hidden');
    fetchAndRenderRolesTable();
    console.log('[DEBUG] Showing Role section (table)');
  }
  
  function showRoleCreateForm() {
    userSection.classList.add('hidden');
    roleSection.classList.remove('hidden');
    toggleUserBtn.classList.add('btn-secondary');
    toggleUserBtn.classList.remove('btn-primary');
    toggleRoleBtn.classList.add('btn-primary');
    toggleRoleBtn.classList.remove('btn-secondary');
    // Show create form, hide roles table
    document.getElementById('role-create-form-container').classList.remove('hidden');
    document.getElementById('roles-table-container').classList.add('hidden');
    console.log('[DEBUG] Showing Role creation form');
  }
  function showUserCreateForm() {
    userTableSection.classList.add('hidden');
    userCreateFormSection.classList.remove('hidden');
    renderRolesOptions(document.getElementById('newUserRoles'));
    document.getElementById('createUserForm').reset();
    console.log('[DEBUG] Showing User Create Form');
  }

  // Attach event listeners with error checks
  if (addUserBtn) addUserBtn.onclick = showUserCreateForm;
  else console.error('[ERROR] addUserBtn not found!');

  if (addRoleBtn) addRoleBtn.onclick = showRoleCreateForm;
  else console.error('[ERROR] addRoleBtn not found!');

  if (toggleUserBtn) toggleUserBtn.onclick = showUserSection;
  else console.error('[ERROR] toggleUserBtn not found!');

  if (toggleRoleBtn) toggleRoleBtn.onclick = showRoleSection;
  else console.error('[ERROR] toggleRoleBtn not found!');

  if (cancelCreateUserBtn) cancelCreateUserBtn.onclick = showUserSection;
  else console.error('[ERROR] cancelCreateUserBtn not found!');

  if (editRolesCancelBtn) editRolesCancelBtn.onclick = closeEditRolesModal;
  else console.error('[ERROR] editRolesCancelBtn not found!');

  if (editRolesSaveBtn) editRolesSaveBtn.onclick = saveEditedRoles;
  else console.error('[ERROR] editRolesSaveBtn not found!');

  // createNewRoleBtn removed from HTML

  if (backToRolesBtn) backToRolesBtn.onclick = showRoleSection;
  else console.error('[ERROR] backToRolesBtn not found!');

  // Only show user section if the user-manager section is visible
  const userManagerSection = document.getElementById('user-manager');
  if (userManagerSection && !userManagerSection.classList.contains('hidden')) {
    showUserSection();
  }

  // Role creation and editing
  const createRoleForm = document.getElementById('createRoleForm');
  console.log('[DEBUG] Create role form found:', !!createRoleForm);
  if (createRoleForm) {
    createRoleForm.onsubmit = async function(e) {
      console.log('[DEBUG] Role form submitted');
      e.preventDefault();
      const roleName = document.getElementById('newRoleName').value.trim();
      const roleDescription = document.getElementById('newRoleDescription').value.trim();
      
      if (!roleName) return alert('Role name required');
      
      // Collect permissions from checkboxes
      const permissionCheckboxes = document.querySelectorAll('input[name="permissions"]:checked');
      const permissions = {};
      
      // Initialize all permissions to false
      const allPermissions = [
        'create_campaigns', 'edit_campaigns', 'delete_campaigns', 'view_campaigns',
        'view_reports', 'export_data', 'manage_users', 'manage_roles', 
        'manage_channels'
      ];
      
      allPermissions.forEach(perm => {
        permissions[perm] = false;
      });
      
      // Set checked permissions to true
      permissionCheckboxes.forEach(checkbox => {
        permissions[checkbox.value] = true;
      });
      
      const isEditMode = createRoleForm.dataset.editMode === 'true';
      const roleId = createRoleForm.dataset.editRoleId;
      
      try {
        const url = isEditMode ? `${apiBase}/roles/${roleId}` : `${apiBase}/roles`;
        const method = isEditMode ? 'PUT' : 'POST';
        
        const res = await fetch(url, {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            name: roleName, 
            description: roleDescription,
            permissions: permissions
          })
        });
        
        const result = await res.json();
        if (result.error) return alert(result.error);
        
        // Reset form
        createRoleForm.reset();
        // Reset checkboxes to default state
        document.getElementById('perm_view_campaigns').checked = true;
        
        // Reset form mode
        createRoleForm.dataset.editMode = 'false';
        delete createRoleForm.dataset.editRoleId;
        
        // Reset button text
        const submitBtn = createRoleForm.querySelector('button[type="submit"]');
        submitBtn.textContent = 'Create Role';
        
        fetchAndRenderRolesTable();
        showRoleSection(); // Go back to roles table
        
        const message = isEditMode ? 'Role updated successfully!' : 'Role created successfully!';
        alert(message);
        
      } catch (err) {
        console.error('Error saving role:', err);
        alert('Failed to save role');
      }
    };
    console.log('[DEBUG] Role form event handler set');
  } else {
    console.error('[DEBUG] Create role form not found!');
  }

  // Create user form handler
  const createUserForm = document.getElementById('createUserForm');
  console.log('[DEBUG] Create user form found:', !!createUserForm);
  if (createUserForm) {
    createUserForm.onsubmit = async (e) => {
      console.log('[DEBUG] Create user form submitted');
    await handleCreateUser(e);
    // After create, return to table
      showUserSection();
    };
    console.log('[DEBUG] Create user form event handler set');
  } else {
    console.error('[DEBUG] Create user form not found!');
  }
  
  // Make all functions globally accessible
  window.renderUsersTable = renderUsersTable;
  window.showEditRoles = showEditRoles;
  window.saveEditedRoles = saveEditedRoles;
  window.closeEditRolesModal = closeEditRolesModal;
  window.removeUser = removeUser;
  window.fetchAndRenderRoles = fetchAndRenderRoles;
  window.fetchAndRenderRolesTable = fetchAndRenderRolesTable;
  
  // Role management functions
  window.editRole = async function(roleId) {
    console.log('[DEBUG] Edit role:', roleId);
    try {
      // Fetch the role data
      const res = await fetch(`${apiBase}/roles/${roleId}`);
      const role = await res.json();
      
      if (role.error) {
        alert('Error loading role: ' + role.error);
        return;
      }
      
      // Populate the edit form (we'll use the create form for editing)
      document.getElementById('newRoleName').value = role.name;
      document.getElementById('newRoleDescription').value = role.description || '';
      
      // Reset all checkboxes first
      document.querySelectorAll('input[name="permissions"]').forEach(checkbox => {
        checkbox.checked = false;
      });
      
      // Check the permissions that are true
      Object.entries(role.permissions || {}).forEach(([perm, value]) => {
        if (value === true) {
          const checkbox = document.querySelector(`input[name="permissions"][value="${perm}"]`);
          if (checkbox) checkbox.checked = true;
        }
      });
      
      // Change form to edit mode
      const form = document.getElementById('createRoleForm');
      const submitBtn = form.querySelector('button[type="submit"]');
      const backBtn = document.getElementById('backToRolesBtn');
      
      submitBtn.textContent = 'Update Role';
      form.dataset.editMode = 'true';
      form.dataset.editRoleId = roleId;
      
      // Show the form
      showRoleCreateForm();
      
    } catch (err) {
      console.error('Error loading role for editing:', err);
      alert('Failed to load role for editing');
    }
  };
  
  window.deleteRole = async function(roleId) {
    if (!confirm('Are you sure you want to delete this role? This action cannot be undone.')) return;
    
    console.log('[DEBUG] Delete role:', roleId);
    try {
      const res = await fetch(`${apiBase}/roles/${roleId}`, {
        method: 'DELETE'
      });
      
      const result = await res.json();
      
      if (result.error) {
        alert('Error deleting role: ' + result.error);
        return;
      }
      
      alert('Role deleted successfully!');
      fetchAndRenderRolesTable(); // Refresh the table
      
    } catch (err) {
      console.error('Error deleting role:', err);
      alert('Failed to delete role');
    }
  };

});
