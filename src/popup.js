/**
 * GST Notice Guard - Popup Script
 * Handles authentication UI and status display
 */

// DOM Elements
const loadingSection = document.getElementById('loading');
const loginSection = document.getElementById('login-section');
const dashboardSection = document.getElementById('dashboard-section');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login-btn');
const webSessionBtn = document.getElementById('web-session-btn');
const loginError = document.getElementById('login-error');
const userName = document.getElementById('user-name');
const orgName = document.getElementById('org-name');
const autoCaptureStatus = document.getElementById('auto-capture-status');
const gstinCount = document.getElementById('gstin-count');
const lastSync = document.getElementById('last-sync');
const openDashboardBtn = document.getElementById('open-dashboard-btn');
const logoutBtn = document.getElementById('logout-btn');
const apiEnvironmentSelect = document.getElementById('api-environment');

// Notification toggles
const notifyEnabledToggle = document.getElementById('notify-enabled');
const notifySyncToggle = document.getElementById('notify-sync');
const notifyDueDatesToggle = document.getElementById('notify-due-dates');

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  try {
    await loadApiEnvironment();

    const authState = await sendMessage({ type: 'GET_AUTH_STATE' });

    if (authState.isLoggedIn) {
      showDashboard(authState);
    } else {
      showLogin();
    }
  } catch (error) {
    console.error('Init error:', error);
    showLogin();
  }
}

// Web app URL for the currently selected environment (fallback: live)
let currentWebUrl = 'https://app.effortlessinsight.in';
let knownEnvironments = {};

async function loadApiEnvironment() {
  try {
    const { environment, environments } = await sendMessage({ type: 'GET_API_ENVIRONMENT' });

    // Populate the selector from the environments the background reports
    knownEnvironments = environments || {};
    apiEnvironmentSelect.innerHTML = '';
    for (const [key, cfg] of Object.entries(knownEnvironments)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = cfg.label || key;
      apiEnvironmentSelect.appendChild(option);
    }
    apiEnvironmentSelect.value = environment;
    updateWebUrl(environment);

    // Release builds ship a single environment — hide the selector entirely
    const envGroup = document.getElementById('env-group');
    if (envGroup && Object.keys(knownEnvironments).length <= 1) {
      envGroup.classList.add('hidden');
    }
  } catch (error) {
    console.error('Failed to load API environment:', error);
  }
}

function updateWebUrl(environmentKey) {
  const webUrl = knownEnvironments[environmentKey]?.webUrl;
  if (webUrl) {
    currentWebUrl = webUrl;
  }

  // Keep footer links pointing at the right app instance
  const registerLink = document.getElementById('register-link');
  if (registerLink) {
    registerLink.href = `${currentWebUrl}/register`;
  }
}

// ============================================================================
// UI States
// ============================================================================

function showLoading() {
  loadingSection.classList.remove('hidden');
  loginSection.classList.add('hidden');
  dashboardSection.classList.add('hidden');
}

function showLogin() {
  loadingSection.classList.add('hidden');
  loginSection.classList.remove('hidden');
  dashboardSection.classList.add('hidden');

  // Focus email input
  emailInput.focus();
}

function showDashboard(authState) {
  loadingSection.classList.add('hidden');
  loginSection.classList.add('hidden');
  dashboardSection.classList.remove('hidden');
  dashboardSection.style.display = 'block';

  // Update user info
  userName.textContent = authState.user?.name || authState.user?.email || 'User';
  orgName.textContent = authState.organization?.name || '-';

  // Load extension config
  loadConfig();
}

async function loadConfig() {
  try {
    const config = await sendMessage({ type: 'GET_CONFIG' });

    if (config) {
      // Update GSTIN count
      gstinCount.textContent = config.enabledGstins?.length || 0;

      // Update auto-capture status
      if (config.autoCapture) {
        autoCaptureStatus.textContent = 'Active';
        autoCaptureStatus.className = 'status-badge active';
      } else {
        autoCaptureStatus.textContent = 'Disabled';
        autoCaptureStatus.className = 'status-badge inactive';
      }
    }

    // Load last sync time from storage
    const { lastSyncTime } = await chrome.storage.local.get('lastSyncTime');
    if (lastSyncTime) {
      const date = new Date(lastSyncTime);
      lastSync.textContent = formatRelativeTime(date);
    }

    // Load notification preferences
    await loadNotificationPreferences();
  } catch (error) {
    console.error('Failed to load config:', error);
  }
}

async function loadNotificationPreferences() {
  try {
    const prefs = await sendMessage({ type: 'GET_NOTIFICATION_PREFERENCES' });

    if (prefs) {
      notifyEnabledToggle.checked = prefs.enabled !== false;
      notifySyncToggle.checked = prefs.types?.sync_completed !== false;
      notifyDueDatesToggle.checked = prefs.types?.due_date_reminder !== false;

      // Disable individual toggles if notifications are disabled
      updateNotificationToggleStates();
    }
  } catch (error) {
    console.error('Failed to load notification preferences:', error);
  }
}

function updateNotificationToggleStates() {
  const isEnabled = notifyEnabledToggle.checked;
  notifySyncToggle.disabled = !isEnabled;
  notifyDueDatesToggle.disabled = !isEnabled;

  // Visual feedback for disabled state
  notifySyncToggle.parentElement.style.opacity = isEnabled ? '1' : '0.5';
  notifyDueDatesToggle.parentElement.style.opacity = isEnabled ? '1' : '0.5';
}

function formatRelativeTime(date) {
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

// ============================================================================
// Event Handlers
// ============================================================================

apiEnvironmentSelect.addEventListener('change', async () => {
  try {
    await sendMessage({
      type: 'SET_API_ENVIRONMENT',
      data: { environment: apiEnvironmentSelect.value }
    });
    updateWebUrl(apiEnvironmentSelect.value);
  } catch (error) {
    console.error('Failed to set API environment:', error);
    showError('Could not switch server. Please try again.');
    // Reload to reflect the actual stored value
    await loadApiEnvironment();
  }
});

loginBtn.addEventListener('click', handleLogin);

webSessionBtn.addEventListener('click', handleWebSessionLogin);

async function handleWebSessionLogin() {
  webSessionBtn.disabled = true;
  webSessionBtn.textContent = 'Connecting...';
  hideError();

  try {
    const result = await sendMessage({ type: 'LOGIN_WITH_WEB_SESSION' });

    if (result.success) {
      showDashboard({
        isLoggedIn: true,
        user: result.user,
        organization: result.organization
      });
    } else {
      showError(result.error || 'Could not connect to your web session.');
    }
  } catch (error) {
    showError(error.message || 'Could not connect to your web session.');
  } finally {
    webSessionBtn.disabled = false;
    webSessionBtn.textContent = 'Use my EffortlessInsight session';
  }
}

emailInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') passwordInput.focus();
});

passwordInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') handleLogin();
});

async function handleLogin() {
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showError('Please enter email and password');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in...';
  hideError();

  try {
    const result = await sendMessage({
      type: 'LOGIN',
      data: { email, password }
    });

    if (result.success) {
      showDashboard({
        isLoggedIn: true,
        user: result.user,
        organization: result.organization
      });
    } else {
      showError(result.error || 'Login failed');
    }
  } catch (error) {
    showError(error.message || 'Login failed. Please try again.');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
}

logoutBtn.addEventListener('click', async () => {
  try {
    await sendMessage({ type: 'LOGOUT' });
    showLogin();
  } catch (error) {
    console.error('Logout error:', error);
  }
});

openDashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: `${currentWebUrl}/gst-sync` });
  window.close();
});

// Notification toggle listeners
notifyEnabledToggle.addEventListener('change', async () => {
  try {
    await sendMessage({
      type: 'UPDATE_NOTIFICATION_PREFERENCE',
      data: { key: 'enabled', value: notifyEnabledToggle.checked }
    });
    updateNotificationToggleStates();
  } catch (error) {
    console.error('Failed to update notification preference:', error);
    // Revert toggle on error
    notifyEnabledToggle.checked = !notifyEnabledToggle.checked;
  }
});

notifySyncToggle.addEventListener('change', async () => {
  try {
    await sendMessage({
      type: 'UPDATE_NOTIFICATION_PREFERENCE',
      data: { key: 'types.sync_completed', value: notifySyncToggle.checked }
    });
  } catch (error) {
    console.error('Failed to update notification preference:', error);
    notifySyncToggle.checked = !notifySyncToggle.checked;
  }
});

notifyDueDatesToggle.addEventListener('change', async () => {
  try {
    await sendMessage({
      type: 'UPDATE_NOTIFICATION_PREFERENCE',
      data: { key: 'types.due_date_reminder', value: notifyDueDatesToggle.checked }
    });
    // Also update overdue notifications with the same preference
    await sendMessage({
      type: 'UPDATE_NOTIFICATION_PREFERENCE',
      data: { key: 'types.due_date_overdue', value: notifyDueDatesToggle.checked }
    });
  } catch (error) {
    console.error('Failed to update notification preference:', error);
    notifyDueDatesToggle.checked = !notifyDueDatesToggle.checked;
  }
});

// ============================================================================
// Utilities
// ============================================================================

function showError(message) {
  loginError.textContent = message;
  loginError.classList.remove('hidden');
}

function hideError() {
  loginError.classList.add('hidden');
}

async function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

// ============================================================================
// Initialize
// ============================================================================

document.addEventListener('DOMContentLoaded', init);
