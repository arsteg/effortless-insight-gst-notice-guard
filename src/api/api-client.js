/**
 * GST Notice Guard - API Client
 * Handles all communication with the EffortlessInsight backend
 */

import { getApiBaseUrl } from '../config.js';

// Abort any backend call that hangs longer than this — a stuck fetch would
// otherwise stall a sync until Chrome kills the service worker.
const REQUEST_TIMEOUT_MS = 30000;

export class ApiClient {

  /**
   * Get stored access token
   */
  async getAccessToken() {
    const { accessToken } = await chrome.storage.local.get('accessToken');
    return accessToken;
  }

  /**
   * Make authenticated API call with auto-refresh
   */
  async request(method, endpoint, body = null, options = {}) {
    const accessToken = await this.getAccessToken();

    if (!accessToken && !options.skipAuth) {
      throw new Error('Not authenticated');
    }

    const headers = {
      'Content-Type': 'application/json',
      ...(accessToken && { 'Authorization': `Bearer ${accessToken}` }),
      ...options.headers
    };

    const baseUrl = await getApiBaseUrl();
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    // Refresh-and-retry at most once: if the retried request still comes back
    // 401 the session is genuinely dead, and looping refresh->401 forever
    // would hammer the API.
    if (response.status === 401 && !options.skipAuth && !options.retried) {
      const refreshed = await this.refreshToken();
      if (refreshed) {
        return this.request(method, endpoint, body, { ...options, retried: true });
      }
      throw new Error('Session expired. Please log in again.');
    }

    let data;
    try {
      data = await response.json();
    } catch {
      // Non-JSON body (e.g. an HTML error page from a proxy). Surface the
      // HTTP status instead of a confusing JSON parse error.
      if (!response.ok) {
        const error = new Error(`API request failed (HTTP ${response.status})`);
        error.status = response.status;
        throw error;
      }
      throw new Error('Unexpected non-JSON response from API');
    }

    if (!response.ok) {
      const error = new Error(data.message || 'API request failed');
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  /**
   * Refresh access token
   */
  async refreshToken() {
    const { refreshToken: token } = await chrome.storage.local.get('refreshToken');
    if (!token) return false;

    try {
      const baseUrl = await getApiBaseUrl();
      const response = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (!response.ok) return false;

      const data = await response.json();

      await chrome.storage.local.set({
        accessToken: data.data.accessToken,
        refreshToken: data.data.refreshToken
      });

      return true;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Auth Endpoints
  // ============================================================================

  async login(email, password) {
    return this.request('POST', '/auth/login', { email, password }, { skipAuth: true });
  }

  // ============================================================================
  // GST Sync Endpoints
  // ============================================================================

  /**
   * Start a new sync session
   */
  async startSyncSession(data) {
    const response = await this.request('POST', '/gst-sync/sync/start', data);
    return response.data;
  }

  /**
   * Sync notices batch
   */
  async syncNotices(data) {
    const response = await this.request('POST', '/gst-sync/sync/notices', data);
    return response.data;
  }

  /**
   * Complete sync session
   */
  async completeSyncSession(data) {
    const response = await this.request('POST', '/gst-sync/sync/complete', data);
    return response.data;
  }

  /**
   * Get extension configuration
   */
  async getExtensionConfig() {
    const response = await this.request('GET', '/gst-sync/extension/config');
    return response.data;
  }

  /**
   * Send heartbeat
   */
  async sendHeartbeat(data) {
    const response = await this.request('POST', '/gst-sync/extension/heartbeat', data);
    return response.data;
  }

  /**
   * Log event
   */
  async logEvent(data) {
    const response = await this.request('POST', '/gst-sync/extension/event', data);
    return response.data;
  }

  /**
   * Get GST clients for organization
   */
  async getGstClients() {
    const response = await this.request('GET', '/gst-sync/clients');
    return response.data;
  }

  /**
   * Find GST client by GSTIN
   */
  async findGstClientByGstin(gstin) {
    const response = await this.request('GET', `/gst-sync/clients?gstin=${encodeURIComponent(gstin)}`);
    return response.data?.items?.[0] || null;
  }

  /**
   * Register a GSTIN as a GST client for the current organization.
   * The backend also creates an (unverified) entry in the org's GSTIN registry.
   */
  async createGstClient(data) {
    const response = await this.request('POST', '/gst-sync/clients', data);
    return response.data;
  }

  /**
   * Get presigned URL for PDF upload
   */
  async getPdfUploadUrl(data) {
    const response = await this.request('POST', '/gst-sync/notices/pdf/upload-url', data);
    return response.data;
  }

  /**
   * Confirm PDF upload
   */
  async confirmPdfUpload(data) {
    const response = await this.request('POST', '/gst-sync/notices/pdf/confirm', data);
    return response.data;
  }

  /**
   * Get upcoming due dates for notifications
   */
  async getUpcomingDueDates() {
    const response = await this.request('GET', '/gst-sync/notices/upcoming-due-dates');
    return response.data;
  }
}

export default ApiClient;
