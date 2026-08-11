/**
 * GST Notice Guard - Background Service Worker
 * Handles authentication, sync scheduling, and message routing
 */

import { ApiClient } from './api/api-client.js';
import { SyncManager } from './sync/sync-manager.js';
import { NotificationManager } from './notifications/notification-manager.js';
import { getApiBaseUrl, getApiEnvironment, setApiEnvironment, getWebUrl, API_ENVIRONMENTS } from './config.js';

// Configuration
const SYNC_ALARM_NAME = 'gst-sync-alarm';
const HEARTBEAT_ALARM_NAME = 'heartbeat-alarm';
const DUE_DATE_CHECK_ALARM = 'due-date-check-alarm';

// Instances
const apiClient = new ApiClient();
const syncManager = new SyncManager(apiClient);
const notificationManager = new NotificationManager();

// ============================================================================
// Initialization
// ============================================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[GST Guard] Extension installed:', details.reason);

  if (details.reason === 'install') {
    // First install - log event
    await logEvent('installed', { version: chrome.runtime.getManifest().version });

    // Open welcome/login page
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup.html?welcome=true') });
  } else if (details.reason === 'update') {
    // Extension updated
    await logEvent('updated', {
      previousVersion: details.previousVersion,
      currentVersion: chrome.runtime.getManifest().version
    });
  }

  // Setup alarms
  await setupAlarms();

  // Initialize managers
  await initManagers();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[GST Guard] Browser started');
  await setupAlarms();
  await initManagers();
});

/**
 * Initialize the notification and sync managers, then drain any offline queue
 * once on startup. Each init is guarded so a single failure can't tear down the
 * whole service worker.
 */
async function initManagers() {
  try {
    await notificationManager.init();
  } catch (error) {
    console.error('[GST Guard] NotificationManager init failed:', error);
  }

  try {
    await syncManager.init();
  } catch (error) {
    console.error('[GST Guard] SyncManager init failed:', error);
  }

  // Drain the offline queue once on startup (alarms take over from there).
  try {
    await syncManager.processOfflineQueue();
  } catch (error) {
    console.error('[GST Guard] Startup offline queue drain failed:', error);
  }
}

// ============================================================================
// Alarm Handlers
// ============================================================================

async function setupAlarms() {
  // Heartbeat every 5 minutes
  chrome.alarms.create(HEARTBEAT_ALARM_NAME, { periodInMinutes: 5 });

  // Sync check alarm (checks if any syncs are due)
  chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 15 });

  // Due date check alarm - run every hour
  chrome.alarms.create(DUE_DATE_CHECK_ALARM, { periodInMinutes: 60 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEARTBEAT_ALARM_NAME) {
    await handleHeartbeat();
  } else if (alarm.name === SYNC_ALARM_NAME) {
    await checkPendingSyncs();
  } else if (alarm.name === DUE_DATE_CHECK_ALARM) {
    await checkDueDates();
  }
});

async function handleHeartbeat() {
  const authState = await getAuthState();
  if (!authState.isLoggedIn) return;

  try {
    const response = await apiClient.sendHeartbeat({
      extensionVersion: chrome.runtime.getManifest().version,
      browserInfo: navigator.userAgent,
      lastActivity: new Date().toISOString()
    });

    if (response.updateAvailable) {
      await notificationManager.notifyUpdateAvailable({
        currentVersion: chrome.runtime.getManifest().version,
        latestVersion: response.latestVersion
      });
    }
  } catch (error) {
    console.error('[GST Guard] Heartbeat failed:', error);
  }
}

async function checkPendingSyncs() {
  // Drain the offline queue. In an MV3 service worker there are no
  // online/offline window events, so this alarm-driven call is what retries
  // syncs that were queued while offline. processOfflineQueue() no-ops when
  // the queue is empty or the browser is offline (navigator.onLine).
  console.log('[GST Guard] Checking pending syncs...');
  try {
    await syncManager.processOfflineQueue();
  } catch (error) {
    console.error('[GST Guard] Offline queue processing failed:', error);
  }
}

async function checkDueDates() {
  const authState = await getAuthState();
  if (!authState.isLoggedIn) return;

  console.log('[GST Guard] Checking due dates...');

  try {
    // Fetch upcoming due dates from backend
    const dueDates = await apiClient.getUpcomingDueDates();

    if (!dueDates?.notices?.length) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get last notification times from storage
    const { dueDateNotifications = {} } = await chrome.storage.local.get('dueDateNotifications');

    for (const notice of dueDates.notices) {
      if (!notice.dueDate) continue;

      const dueDate = new Date(notice.dueDate);
      const daysUntilDue = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
      const noticeKey = `${notice.id}_${notice.dueDate}`;

      // Skip if already notified today
      const lastNotified = dueDateNotifications[noticeKey];
      if (lastNotified && new Date(lastNotified).toDateString() === today.toDateString()) {
        continue;
      }

      // Notify based on days until due
      if (daysUntilDue < 0) {
        // Overdue
        await notificationManager.notifyDueDateOverdue({
          noticeType: notice.noticeType,
          clientName: notice.clientName,
          gstin: notice.gstin,
          daysOverdue: Math.abs(daysUntilDue),
          demandAmount: notice.demandAmount
        });
        dueDateNotifications[noticeKey] = new Date().toISOString();
      } else if (daysUntilDue <= 7) {
        // Upcoming due date (within 7 days)
        await notificationManager.notifyDueDateReminder({
          noticeType: notice.noticeType,
          clientName: notice.clientName,
          gstin: notice.gstin,
          daysUntilDue,
          demandAmount: notice.demandAmount
        });
        dueDateNotifications[noticeKey] = new Date().toISOString();
      }
    }

    // Prune stale entries so this map doesn't grow unbounded: drop any whose
    // last-notified timestamp is older than 30 days.
    const pruneCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const [key, timestamp] of Object.entries(dueDateNotifications)) {
      if (new Date(timestamp).getTime() < pruneCutoff) {
        delete dueDateNotifications[key];
      }
    }

    // Save notification times
    await chrome.storage.local.set({ dueDateNotifications });
  } catch (error) {
    console.error('[GST Guard] Due date check failed:', error);
  }
}

// ============================================================================
// Message Handlers (from content script and popup)
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(error => sendResponse({ error: error.message }));

  // Return true to indicate we'll call sendResponse asynchronously
  return true;
});

async function handleMessage(message, sender) {
  const { type, data } = message;

  switch (type) {
    case 'GET_AUTH_STATE':
      return await getAuthState();

    case 'GET_API_ENVIRONMENT':
      return { environment: await getApiEnvironment(), environments: API_ENVIRONMENTS };

    case 'SET_API_ENVIRONMENT':
      await setApiEnvironment(data.environment);
      return { success: true, environment: data.environment };

    case 'LOGIN':
      return await handleLogin(data);

    case 'LOGIN_WITH_WEB_SESSION':
      return await handleLoginWithWebSession();

    case 'EI_SESSION_PUSH':
      return await handleSessionPush(data);

    case 'LOGOUT':
      return await handleLogout();

    case 'GET_CONFIG':
      return await getExtensionConfig();

    case 'START_SYNC':
      return await startSyncSession(data);

    case 'SYNC_NOTICES':
      return await syncNotices(data);

    case 'COMPLETE_SYNC':
      return await completeSyncSession(data);

    case 'SYNC_NOTICES_DIRECT':
      return await handleDirectSync(data);

    case 'LOG_EVENT':
      return await logEvent(data.eventType, data.eventData);

    case 'GST_LOGIN_DETECTED':
      return await handleGstLoginDetected(data);

    case 'NOTICES_CAPTURED':
      return await handleNoticesCaptured(data);

    case 'GET_GST_CLIENT':
      return await getGstClientByGstin(data.gstin);

    case 'REGISTER_GST_CLIENT':
      return await registerGstClient(data);

    // Notification preferences
    case 'GET_NOTIFICATION_PREFERENCES':
      return notificationManager.getPreferences();

    case 'SET_NOTIFICATION_PREFERENCES':
      await notificationManager.savePreferences(data);
      return { success: true };

    case 'UPDATE_NOTIFICATION_PREFERENCE':
      await notificationManager.updatePreference(data.key, data.value);
      return { success: true };

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

// ============================================================================
// Authentication
// ============================================================================

async function getAuthState() {
  const result = await chrome.storage.local.get(['accessToken', 'refreshToken', 'user', 'organization']);
  return {
    isLoggedIn: !!result.accessToken,
    user: result.user || null,
    organization: result.organization || null
  };
}

async function handleLogin(credentials) {
  try {
    const baseUrl = await getApiBaseUrl();
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Login failed');
    }

    // Store tokens
    await chrome.storage.local.set({
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken,
      user: data.data.user,
      organization: data.data.organization
    });

    // Log login event
    await logEvent('login', { userId: data.data.user.id });

    // Fetch and cache extension config
    await getExtensionConfig(true);

    return { success: true, user: data.data.user, organization: data.data.organization };
  } catch (error) {
    console.error('[GST Guard] Login error:', error);
    throw error;
  }
}

async function handleLogout() {
  await chrome.storage.local.remove(['accessToken', 'refreshToken', 'user', 'organization', 'extensionConfig']);
  await logEvent('logout', {});
  return { success: true };
}

/**
 * Sign in by borrowing the user's existing EffortlessInsight web session.
 * Needed for accounts that authenticate via Google/OAuth and have no password.
 * Flow: find (or open) a web app tab -> ask its connector content script for
 * the stored tokens -> validate them via /auth/me -> store like a normal login.
 */
async function handleLoginWithWebSession() {
  const webUrl = await getWebUrl();

  // Find an existing web app tab
  const tabs = await chrome.tabs.query({ url: `${webUrl}/*` });
  let tab = tabs.find(t => t.status === 'complete') || tabs[0];

  if (!tab) {
    return {
      success: false,
      error: `Open ${webUrl} in a tab and sign in there first, then try again.`
    };
  }

  // Ask the connector content script for the session tokens
  let session;
  try {
    session = await chrome.tabs.sendMessage(tab.id, { type: 'EI_GET_SESSION' });
  } catch (error) {
    // Content script not present (tab opened before the extension loaded)
    return {
      success: false,
      error: 'Please reload the EffortlessInsight tab, then try again.'
    };
  }

  if (!session?.success) {
    return {
      success: false,
      error: session?.error === 'NOT_SIGNED_IN'
        ? `You are not signed in at ${webUrl}. Sign in there first, then try again.`
        : (session?.error || 'Could not read the web session.')
    };
  }

  const adopted = await adoptWebSession(session);
  if (!adopted.success) {
    return {
      success: false,
      error: 'Web session is expired. Refresh the EffortlessInsight tab (so it renews the session) and try again.'
    };
  }

  return adopted;
}

/**
 * Silent sign-in: the web app connector offers the session on page load so
 * the extension works with zero popup interaction. Ignored when already
 * signed in; tokens are validated against the selected API before adoption.
 */
async function handleSessionPush(session) {
  const authState = await getAuthState();
  if (authState.isLoggedIn) {
    return { success: false, reason: 'already_signed_in' };
  }

  if (!session?.accessToken || !session?.refreshToken) {
    return { success: false, reason: 'no_tokens' };
  }

  const adopted = await adoptWebSession(session);
  if (adopted.success) {
    console.log('[GST Guard] Auto signed in from web session for', adopted.user?.email);
  }
  return adopted;
}

/**
 * Validate web-session tokens against the selected API environment and, if
 * valid, store them exactly like a normal login. Cross-environment tokens
 * fail /auth/me and are rejected.
 */
async function adoptWebSession(session) {
  const baseUrl = await getApiBaseUrl();

  let meResponse;
  try {
    meResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: { 'Authorization': `Bearer ${session.accessToken}` }
    });
  } catch (error) {
    return { success: false, reason: 'api_unreachable' };
  }

  if (!meResponse.ok) {
    return { success: false, reason: 'invalid_token' };
  }

  const me = await meResponse.json();
  const profile = me?.data;

  if (!profile) {
    return { success: false, reason: 'unexpected_response' };
  }

  const user = { id: profile.id, name: profile.name, email: profile.email };
  const organization = profile.organization || null;

  await chrome.storage.local.set({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    user,
    organization
  });

  await logEvent('login', { userId: user.id, method: 'web_session' });

  // Fetch and cache extension config
  await getExtensionConfig(true);

  return { success: true, user, organization };
}

// ============================================================================
// Extension Configuration
// ============================================================================

async function getExtensionConfig(forceRefresh = false) {
  if (!forceRefresh) {
    const { extensionConfig, configCachedAt } = await chrome.storage.local.get(['extensionConfig', 'configCachedAt']);

    // Use cached config if less than 5 minutes old
    if (extensionConfig && configCachedAt && (Date.now() - configCachedAt) < 5 * 60 * 1000) {
      return extensionConfig;
    }
  }

  try {
    const config = await apiClient.getExtensionConfig();

    await chrome.storage.local.set({
      extensionConfig: config,
      configCachedAt: Date.now()
    });

    return config;
  } catch (error) {
    console.error('[GST Guard] Failed to fetch config:', error);

    // Return cached config if available
    const { extensionConfig } = await chrome.storage.local.get('extensionConfig');
    return extensionConfig || null;
  }
}

// ============================================================================
// Sync Operations
// ============================================================================

async function startSyncSession(data) {
  const response = await apiClient.startSyncSession(data);
  return response;
}

async function syncNotices(data) {
  const response = await apiClient.syncNotices(data);
  return response;
}

async function completeSyncSession(data) {
  const response = await apiClient.completeSyncSession(data);
  return response;
}

/**
 * Handle direct sync from content script
 * This finds the GST client and initiates sync via SyncManager
 */
async function handleDirectSync(data) {
  const { gstin, notices } = data;

  if (!gstin || !notices || notices.length === 0) {
    return { success: false, error: 'No GSTIN or notices provided' };
  }

  try {
    // Find the GST client for this GSTIN
    const gstClient = await apiClient.findGstClientByGstin(gstin);

    if (!gstClient) {
      // Client not registered - notify user
      console.log('[GST Guard] GSTIN not registered:', gstin);
      return {
        success: false,
        error: 'GSTIN not registered. Please add this GSTIN in EffortlessInsight dashboard first.'
      };
    }

    // Defensive guard: ensure the returned client actually matches the detected
    // GSTIN. If the backend ever returns a mismatched client, treat it as
    // not-registered rather than syncing notices under the wrong client.
    if (gstClient.gstin && gstClient.gstin !== gstin) {
      console.warn('[GST Guard] GSTIN mismatch - detected:', gstin, 'client:', gstClient.gstin);
      return {
        success: false,
        error: 'GSTIN not registered. Please add this GSTIN in EffortlessInsight dashboard first.'
      };
    }

    // Check if sync is enabled for this client
    if (!gstClient.syncEnabled) {
      console.log('[GST Guard] Sync disabled for GSTIN:', gstin);
      return {
        success: false,
        error: 'Sync is disabled for this GSTIN.'
      };
    }

    // Whether to download PDFs is an extension-wide setting, not a field on the
    // GstClientDto (which has no downloadPdfs). Source it from the cached
    // extension config's autoDownloadPdf flag; default false if unavailable.
    const extensionConfig = await getExtensionConfig();
    const downloadPdfs = extensionConfig?.autoDownloadPdf || false;

    // Initiate sync via SyncManager
    const result = await syncManager.startSync(gstClient.id, gstin, notices, {
      downloadPdfs,
      metadata: {
        triggeredBy: 'content_script',
        pageUrl: data.pageUrl
      }
    });

    // Update last sync time
    await chrome.storage.local.set({ lastSyncTime: Date.now() });

    // Send sync completed notification
    if (result.success) {
      await notificationManager.notifySyncCompleted({
        gstin,
        clientName: gstClient.clientName,
        newCount: result.syncResult?.new || 0,
        updatedCount: result.syncResult?.updated || 0,
        totalCount: result.syncResult?.total || notices.length
      });
    }

    return {
      success: true,
      result: result
    };

  } catch (error) {
    console.error('[GST Guard] Direct sync failed:', error);

    // Get client info for notification
    const gstClient = await apiClient.findGstClientByGstin(gstin).catch(() => null);

    // If network error, the SyncManager may have queued it
    if (error.message?.includes('queued')) {
      await notificationManager.notifyOfflineQueue({
        queuedCount: notices.length
      });
      return {
        success: true,
        queued: true,
        message: 'Sync queued for when online'
      };
    }

    // Notify about sync failure
    await notificationManager.notifySyncFailed({
      gstin,
      clientName: gstClient?.clientName,
      errorMessage: error.message,
      consecutiveFailures: 1
    });

    return {
      success: false,
      error: error.message
    };
  }
}

async function getGstClientByGstin(gstin) {
  try {
    return await apiClient.findGstClientByGstin(gstin);
  } catch (error) {
    console.error('[GST Guard] Failed to find GST client:', error);
    return null;
  }
}

/**
 * Register a GSTIN as a GST client after the user confirmed the link
 * in the content-script prompt. Returns { success, client } or { success:false, error }.
 */
async function registerGstClient(data) {
  const { gstin, tradeName } = data || {};

  if (!gstin) {
    return { success: false, error: 'No GSTIN provided' };
  }

  try {
    const client = await apiClient.createGstClient({
      gstin,
      tradeName: tradeName || null,
      legalName: null
    });

    await logEvent('gst_client_registered', {
      gstin,
      clientId: client?.id || null,
      source: 'content_script_confirmation'
    });

    return { success: true, client };
  } catch (error) {
    console.error('[GST Guard] Failed to register GST client:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Event Logging
// ============================================================================

async function logEvent(eventType, eventData) {
  try {
    await apiClient.logEvent({
      eventType,
      eventData,
      extensionVersion: chrome.runtime.getManifest().version,
      browserInfo: navigator.userAgent
    });
  } catch (error) {
    // Log locally if API fails
    console.log('[GST Guard] Event (local):', eventType, eventData);
  }
}

// ============================================================================
// GST Portal Event Handlers
// ============================================================================

async function handleGstLoginDetected(data) {
  console.log('[GST Guard] GST login detected:', data);
  await logEvent('gst_login_detected', data);

  // Check if GSTIN is registered
  const gstClient = await getGstClientByGstin(data.gstin);

  await notificationManager.notifyGstLogin({
    gstin: data.gstin,
    registered: !!gstClient,
    clientName: gstClient?.clientName || null
  });

  return { success: true, registered: !!gstClient };
}

async function handleNoticesCaptured(data) {
  console.log('[GST Guard] Notices captured:', data.notices?.length || 0);

  // Show notification with count
  if (data.notices?.length > 0) {
    await notificationManager.notifyNoticesCaptured({
      gstin: data.gstin,
      count: data.notices.length,
      syncing: true
    });
  }

  return { success: true };
}

// ============================================================================
// Sync Progress Handler
// ============================================================================

// Listen for sync progress updates from SyncManager
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SYNC_PROGRESS') {
    // Forward to popup if open
    chrome.runtime.sendMessage(message).catch(() => {
      // Popup not open, ignore
    });

    // Handle offline queue processed event
    if (message.data?.type === 'offline_queue_processed' && message.data.processed > 0) {
      notificationManager.notifyOfflineQueue({
        processed: message.data.processed
      });
    }
  }
});

console.log('[GST Guard] Background service worker loaded');
