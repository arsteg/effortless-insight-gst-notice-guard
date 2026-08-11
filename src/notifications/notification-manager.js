/**
 * GST Notice Guard - Notification Manager
 * Handles all browser notifications with configurable preferences
 */

import { getWebUrl } from '../config.js';

// Notification types
export const NotificationType = {
  SYNC_STARTED: 'sync_started',
  SYNC_COMPLETED: 'sync_completed',
  SYNC_FAILED: 'sync_failed',
  NOTICES_CAPTURED: 'notices_captured',
  GST_LOGIN: 'gst_login',
  DUE_DATE_REMINDER: 'due_date_reminder',
  DUE_DATE_OVERDUE: 'due_date_overdue',
  EXTENSION_UPDATE: 'extension_update',
  OFFLINE_QUEUE: 'offline_queue'
};

// Default notification preferences
const DEFAULT_PREFERENCES = {
  enabled: true,
  sound: true,
  types: {
    [NotificationType.SYNC_COMPLETED]: true,
    [NotificationType.SYNC_FAILED]: true,
    [NotificationType.NOTICES_CAPTURED]: true,
    [NotificationType.GST_LOGIN]: true,
    [NotificationType.DUE_DATE_REMINDER]: true,
    [NotificationType.DUE_DATE_OVERDUE]: true,
    [NotificationType.EXTENSION_UPDATE]: true,
    [NotificationType.OFFLINE_QUEUE]: true
  }
};

const PREFERENCES_KEY = 'notification_preferences';

/**
 * Notification Manager Class
 */
export class NotificationManager {
  constructor() {
    this.preferences = null;
    this.initialized = false;
  }

  /**
   * Initialize notification manager
   */
  async init() {
    if (this.initialized) return;

    await this.loadPreferences();
    this.setupClickHandler();
    this.initialized = true;

    console.log('[NotificationManager] Initialized with preferences:', this.preferences);
  }

  /**
   * Load preferences from storage
   */
  async loadPreferences() {
    try {
      const result = await chrome.storage.local.get(PREFERENCES_KEY);
      this.preferences = { ...DEFAULT_PREFERENCES, ...result[PREFERENCES_KEY] };
    } catch (error) {
      console.error('[NotificationManager] Failed to load preferences:', error);
      this.preferences = DEFAULT_PREFERENCES;
    }
  }

  /**
   * Save preferences to storage
   */
  async savePreferences(preferences) {
    this.preferences = { ...this.preferences, ...preferences };
    await chrome.storage.local.set({ [PREFERENCES_KEY]: this.preferences });
  }

  /**
   * Get current preferences
   */
  getPreferences() {
    return this.preferences;
  }

  /**
   * Update specific preference
   */
  async updatePreference(key, value) {
    if (key.startsWith('types.')) {
      const type = key.replace('types.', '');
      this.preferences.types[type] = value;
    } else {
      this.preferences[key] = value;
    }
    await this.savePreferences(this.preferences);
  }

  /**
   * Check if notification type is enabled
   */
  isEnabled(type) {
    if (!this.preferences.enabled) return false;
    return this.preferences.types[type] !== false;
  }

  /**
   * Setup click handler for notifications
   */
  setupClickHandler() {
    chrome.notifications.onClicked.addListener((notificationId) => {
      this.handleNotificationClick(notificationId);
    });

    chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
      this.handleButtonClick(notificationId, buttonIndex);
    });
  }

  /**
   * Handle notification click
   */
  async handleNotificationClick(notificationId) {
    // Extract type from notification ID (format: type-timestamp)
    // Handle types with underscores like 'due_date_reminder-123456'
    const parts = notificationId.split('-');
    const type = parts.slice(0, -1).join('-') || parts[0]; // Rejoin all but last part (timestamp)

    // Route within the web app of the SELECTED environment (live or local)
    const webUrl = await getWebUrl();
    let url;

    switch (type) {
      case NotificationType.DUE_DATE_REMINDER:
      case NotificationType.DUE_DATE_OVERDUE:
        url = `${webUrl}/notices`;
        break;
      case NotificationType.EXTENSION_UPDATE:
        url = 'https://chrome.google.com/webstore/detail/gst-notice-guard';
        break;
      case NotificationType.SYNC_COMPLETED:
      case NotificationType.SYNC_FAILED:
      case NotificationType.NOTICES_CAPTURED:
      case NotificationType.GST_LOGIN:
      case NotificationType.OFFLINE_QUEUE:
      default:
        url = `${webUrl}/gst-sync`;
        break;
    }

    chrome.tabs.create({ url });
    chrome.notifications.clear(notificationId);
  }

  /**
   * Handle button click on notification
   */
  handleButtonClick(notificationId, buttonIndex) {
    const [type] = notificationId.split('-');

    if (buttonIndex === 0) {
      // Primary action - usually view/open
      this.handleNotificationClick(notificationId);
    } else if (buttonIndex === 1) {
      // Secondary action - usually dismiss
      chrome.notifications.clear(notificationId);
    }
  }

  /**
   * Show notification
   */
  async show(type, options) {
    if (!this.isEnabled(type)) {
      console.log('[NotificationManager] Notification disabled for type:', type);
      return null;
    }

    const notificationId = `${type}-${Date.now()}`;

    const notificationOptions = {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icon-128.png'),
      ...options
    };

    // Add silent option if sound is disabled
    if (!this.preferences.sound) {
      notificationOptions.silent = true;
    }

    return new Promise((resolve) => {
      chrome.notifications.create(notificationId, notificationOptions, (id) => {
        if (chrome.runtime.lastError) {
          console.error('[NotificationManager] Failed to create notification:', chrome.runtime.lastError);
          resolve(null);
        } else {
          resolve(id);
        }
      });
    });
  }

  // ============================================================================
  // Notification Helpers
  // ============================================================================

  /**
   * Notify sync completed
   */
  async notifySyncCompleted(data) {
    const { gstin, clientName, newCount, updatedCount, totalCount } = data;

    let message = `Synced ${totalCount} notice(s) for ${clientName || gstin}`;
    if (newCount > 0) {
      message = `Found ${newCount} new notice(s) for ${clientName || gstin}`;
    }

    return this.show(NotificationType.SYNC_COMPLETED, {
      title: 'GST Sync Completed',
      message,
      priority: 0,
      requireInteraction: newCount > 0
    });
  }

  /**
   * Notify sync failed
   */
  async notifySyncFailed(data) {
    const { gstin, clientName, errorMessage, consecutiveFailures } = data;

    let message = `Sync failed for ${clientName || gstin}`;
    if (errorMessage) {
      message += `: ${errorMessage}`;
    }
    if (consecutiveFailures > 1) {
      message += ` (${consecutiveFailures} consecutive failures)`;
    }

    return this.show(NotificationType.SYNC_FAILED, {
      title: 'GST Sync Failed',
      message,
      priority: 2,
      requireInteraction: consecutiveFailures >= 3
    });
  }

  /**
   * Notify notices captured
   */
  async notifyNoticesCaptured(data) {
    const { gstin, count, syncing } = data;

    const message = syncing
      ? `Found ${count} notice(s). Syncing to EffortlessInsight...`
      : `Found ${count} notice(s) for ${gstin}. Click to view.`;

    return this.show(NotificationType.NOTICES_CAPTURED, {
      title: 'GST Notices Captured',
      message,
      priority: 0
    });
  }

  /**
   * Notify GST login detected
   */
  async notifyGstLogin(data) {
    const { gstin, registered, clientName } = data;

    const title = 'GST Portal Login Detected';
    let message;

    if (registered) {
      message = `Logged in as ${clientName || gstin}. Notices will be captured automatically.`;
    } else {
      message = `GSTIN ${gstin} is not registered. Add it in EffortlessInsight to enable sync.`;
    }

    return this.show(NotificationType.GST_LOGIN, {
      title,
      message,
      priority: registered ? 0 : 1
    });
  }

  /**
   * Notify due date reminder
   */
  async notifyDueDateReminder(data) {
    const { noticeType, clientName, gstin, daysUntilDue, demandAmount } = data;

    let message = `${noticeType} notice for ${clientName || gstin} is due in ${daysUntilDue} day(s)`;
    if (demandAmount) {
      message += ` (₹${demandAmount.toLocaleString()})`;
    }

    return this.show(NotificationType.DUE_DATE_REMINDER, {
      title: 'Due Date Reminder',
      message,
      priority: daysUntilDue <= 3 ? 2 : 1,
      requireInteraction: daysUntilDue <= 3
    });
  }

  /**
   * Notify due date overdue
   */
  async notifyDueDateOverdue(data) {
    const { noticeType, clientName, gstin, daysOverdue, demandAmount } = data;

    let message = `${noticeType} notice for ${clientName || gstin} is ${daysOverdue} day(s) OVERDUE!`;
    if (demandAmount) {
      message += ` (₹${demandAmount.toLocaleString()})`;
    }

    return this.show(NotificationType.DUE_DATE_OVERDUE, {
      title: 'OVERDUE Notice',
      message,
      priority: 2,
      requireInteraction: true
    });
  }

  /**
   * Notify extension update available
   */
  async notifyUpdateAvailable(data) {
    const { currentVersion, latestVersion } = data;

    return this.show(NotificationType.EXTENSION_UPDATE, {
      title: 'Update Available',
      message: `A new version (${latestVersion}) of GST Notice Guard is available. Click to update.`,
      priority: 1
    });
  }

  /**
   * Notify offline queue status
   */
  async notifyOfflineQueue(data) {
    const { queuedCount, processed } = data;

    if (processed) {
      return this.show(NotificationType.OFFLINE_QUEUE, {
        title: 'Offline Sync Completed',
        message: `Successfully synced ${processed} queued notice(s).`,
        priority: 0
      });
    } else {
      return this.show(NotificationType.OFFLINE_QUEUE, {
        title: 'Notices Queued',
        message: `${queuedCount} notice(s) queued for sync when online.`,
        priority: 0
      });
    }
  }
}

export default NotificationManager;
