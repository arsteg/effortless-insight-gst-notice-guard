/**
 * GST Notice Guard - Sync Manager
 * Handles synchronization of notices with the backend, including:
 * - Session management
 * - Batch uploads
 * - PDF handling
 * - Offline queue
 * - Retry logic
 */

// Constants
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const BATCH_SIZE = 50;
const OFFLINE_QUEUE_KEY = 'gst_guard_offline_queue';

/**
 * Sync Manager Class
 */
export class SyncManager {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.currentSession = null;
    this.syncInProgress = false;
    this.offlineQueue = [];
    // Optional direct callback for the service worker, which never receives
    // its own runtime messages (see notifyProgress).
    this.onProgress = null;
  }

  /**
   * Initialize sync manager
   */
  async init() {
    // Load offline queue from storage
    await this.loadOfflineQueue();

    // Check for pending syncs
    if (this.offlineQueue.length > 0 && navigator.onLine) {
      console.log('[SyncManager] Found pending offline syncs:', this.offlineQueue.length);
      this.processOfflineQueue();
    }

    // NOTE: online/offline window events are not available in an MV3 service
    // worker (no `window`). The offline queue is instead drained by the
    // SYNC_ALARM handler in background.js, which calls processOfflineQueue().
  }

  /**
   * Start a new sync for a GSTIN
   */
  async startSync(gstClientId, gstin, notices, options = {}) {
    if (this.syncInProgress) {
      throw new Error('Sync already in progress');
    }

    // Check if online
    if (!navigator.onLine) {
      console.log('[SyncManager] Offline - queueing sync');
      await this.queueOfflineSync(gstClientId, gstin, notices);
      return { queued: true, message: 'Sync queued for when online' };
    }

    this.syncInProgress = true;
    const startTime = Date.now();

    try {
      // Step 1: Start sync session
      console.log('[SyncManager] Starting sync session for', gstin);
      this.currentSession = await this.startSession(gstClientId, options);

      // Step 2: Sync notices in batches
      const syncResult = await this.syncNoticesInBatches(notices);

      // Step 3: Handle PDFs if enabled
      if (options.downloadPdfs) {
        await this.handlePdfDownloads(notices.filter(n => n.pdfAvailable && n.pdfLink));
      }

      // Step 4: Complete session
      const finalResult = await this.completeSession('completed');

      const duration = Date.now() - startTime;
      console.log('[SyncManager] Sync completed in', duration, 'ms');

      return {
        success: true,
        session: finalResult,
        syncResult,
        duration
      };
    } catch (error) {
      console.error('[SyncManager] Sync failed:', error);

      // Try to complete session with error
      if (this.currentSession) {
        await this.completeSession('failed', error.message);
      }

      // Queue for retry if appropriate
      if (this.shouldRetry(error)) {
        await this.queueOfflineSync(gstClientId, gstin, notices);
      }

      throw error;
    } finally {
      this.syncInProgress = false;
      this.currentSession = null;
    }
  }

  /**
   * Start sync session with retry
   */
  async startSession(gstClientId, options = {}) {
    const request = {
      gstClientId,
      syncSource: 'chrome_extension',
      sourceVersion: chrome.runtime.getManifest().version,
      sourceMetadata: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        // `screen` is not available in an MV3 service worker; omit screenSize.
        ...options.metadata
      }
    };

    return await this.withRetry(() => this.apiClient.startSyncSession(request));
  }

  /**
   * Sync notices in batches
   */
  async syncNoticesInBatches(notices) {
    if (!this.currentSession) {
      throw new Error('No active sync session');
    }

    const results = {
      total: notices.length,
      processed: 0,
      new: 0,
      updated: 0,
      unchanged: 0,
      errors: []
    };

    // Split into batches
    const batches = this.chunkArray(notices, BATCH_SIZE);
    console.log('[SyncManager] Processing', batches.length, 'batches');

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      try {
        const batchResult = await this.withRetry(() =>
          this.apiClient.syncNotices({
            sessionId: this.currentSession.id,
            notices: batch.map(n => this.formatNoticeForApi(n))
          })
        );

        results.processed += batchResult.noticesProcessed || batch.length;
        results.new += batchResult.noticesNew || 0;
        results.updated += batchResult.noticesUpdated || 0;
        results.unchanged += batchResult.noticesUnchanged || 0;

        // Map backend raw-notice IDs onto local notices so PDF upload can reference them
        if (Array.isArray(batchResult.notices)) {
          const idsByPortalId = new Map(
            batchResult.notices.map(n => [n.portalNoticeId, n.id])
          );
          for (const notice of batch) {
            const backendId = idsByPortalId.get(notice.portalNoticeId);
            if (backendId) {
              notice.backendId = backendId;
            }
          }
        }

        if (batchResult.errors?.length > 0) {
          results.errors.push(...batchResult.errors);
        }

        // Notify progress
        this.notifyProgress({
          type: 'batch_complete',
          batch: i + 1,
          totalBatches: batches.length,
          processed: results.processed,
          total: results.total
        });
      } catch (error) {
        console.error('[SyncManager] Batch', i + 1, 'failed:', error);
        results.errors.push(`Batch ${i + 1} failed: ${error.message}`);

        // Continue with next batch
      }
    }

    return results;
  }

  /**
   * Format notice for API
   */
  formatNoticeForApi(notice) {
    return {
      portalNoticeId: notice.portalNoticeId,
      referenceNumber: notice.referenceNumber || null,
      noticeType: notice.noticeType,
      issueDate: notice.issueDate,
      dueDate: notice.dueDate || null,
      statusOnPortal: notice.statusOnPortal || null,
      demandAmount: notice.demandAmount || null,
      taxAmount: notice.taxAmount || null,
      interestAmount: notice.interestAmount || null,
      penaltyAmount: notice.penaltyAmount || null,
      taxPeriod: notice.taxPeriod || null,
      financialYear: notice.financialYear || null,
      sectionRule: notice.section || notice.sectionRule || null,
      officerName: notice.officerName || null,
      officerDesignation: notice.officerDesignation || notice.designation || null,
      jurisdiction: notice.jurisdiction || null,
      pdfAvailable: notice.pdfAvailable || false,
      rawData: notice.rawData || null
    };
  }

  /**
   * Handle PDF downloads and uploads
   */
  async handlePdfDownloads(notices) {
    if (notices.length === 0) return;

    console.log('[SyncManager] Processing', notices.length, 'PDFs');
    let downloaded = 0;
    let failed = 0;

    for (const notice of notices) {
      try {
        if (!notice.backendId) {
          console.warn('[SyncManager] Skipping PDF for', notice.portalNoticeId, '- no backend ID (notice batch may have failed to sync)');
          failed++;
          continue;
        }

        // Download PDF from GST portal
        const pdfBlob = await this.downloadPdf(notice.pdfLink);

        if (pdfBlob) {
          // Get upload URL from backend
          const uploadInfo = await this.apiClient.getPdfUploadUrl({
            noticeId: notice.backendId, // Set by syncNoticesInBatches from the batch response
            fileName: `${notice.noticeType}_${notice.portalNoticeId}.pdf`,
            fileSize: pdfBlob.size
          });

          // Upload to S3
          await this.uploadPdf(uploadInfo.uploadUrl, pdfBlob);

          // Confirm upload
          await this.apiClient.confirmPdfUpload({
            noticeId: notice.backendId,
            s3Key: uploadInfo.s3Key,
            fileSize: pdfBlob.size
          });

          downloaded++;
        }
      } catch (error) {
        console.error('[SyncManager] PDF download/upload failed for', notice.portalNoticeId, error);
        failed++;
      }

      // Notify progress
      this.notifyProgress({
        type: 'pdf_progress',
        downloaded,
        failed,
        total: notices.length
      });
    }

    return { downloaded, failed };
  }

  /**
   * Download PDF from URL
   */
  async downloadPdf(url) {
    try {
      const response = await fetch(url, {
        credentials: 'include' // Include cookies for authenticated download
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();

      // The portal can answer 200 with an HTML error/login page — verify we
      // actually received a PDF (content type or %PDF magic bytes).
      if (!blob.type.includes('pdf')) {
        const head = await blob.slice(0, 5).text();
        if (!head.startsWith('%PDF')) {
          throw new Error(`Not a PDF (content-type: ${blob.type || 'unknown'})`);
        }
      }

      return blob;
    } catch (error) {
      console.error('[SyncManager] PDF download failed:', error);
      return null;
    }
  }

  /**
   * Upload PDF to S3
   */
  async uploadPdf(uploadUrl, blob) {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: {
        'Content-Type': 'application/pdf'
      }
    });

    if (!response.ok) {
      throw new Error(`Upload failed: HTTP ${response.status}`);
    }
  }

  /**
   * Complete sync session
   */
  async completeSession(status, errorMessage = null) {
    if (!this.currentSession) return null;

    try {
      return await this.withRetry(() =>
        this.apiClient.completeSyncSession({
          sessionId: this.currentSession.id,
          status,
          errorMessage,
          errorCode: errorMessage ? 'SYNC_ERROR' : null
        })
      );
    } catch (error) {
      console.error('[SyncManager] Failed to complete session:', error);
      return null;
    }
  }

  // ============================================================================
  // Offline Queue Management
  // ============================================================================

  /**
   * Queue sync for offline processing
   */
  async queueOfflineSync(gstClientId, gstin, notices) {
    const queueItem = {
      id: Date.now().toString(),
      gstClientId,
      gstin,
      notices,
      queuedAt: new Date().toISOString(),
      retryCount: 0
    };

    this.offlineQueue.push(queueItem);
    await this.saveOfflineQueue();

    console.log('[SyncManager] Queued sync for offline processing:', queueItem.id);
    return queueItem;
  }

  /**
   * Process offline queue
   */
  async processOfflineQueue() {
    if (this.offlineQueue.length === 0 || !navigator.onLine) return;

    console.log('[SyncManager] Processing offline queue');

    const itemsToProcess = [...this.offlineQueue];
    this.offlineQueue = [];
    let processedCount = 0;
    let failedCount = 0;

    for (const item of itemsToProcess) {
      try {
        await this.startSync(item.gstClientId, item.gstin, item.notices, {
          isRetry: true,
          originalQueuedAt: item.queuedAt
        });
        processedCount++;
      } catch (error) {
        console.error('[SyncManager] Failed to process queued sync:', item.id, error);
        failedCount++;

        // Re-queue if retries remaining
        if (item.retryCount < MAX_RETRIES) {
          item.retryCount++;
          this.offlineQueue.push(item);
        }
      }
    }

    await this.saveOfflineQueue();

    // Notify about offline queue processing
    if (processedCount > 0) {
      this.notifyProgress({
        type: 'offline_queue_processed',
        processed: processedCount,
        failed: failedCount,
        remaining: this.offlineQueue.length
      });
    }
  }

  /**
   * Load offline queue from storage
   */
  async loadOfflineQueue() {
    try {
      const result = await chrome.storage.local.get(OFFLINE_QUEUE_KEY);
      this.offlineQueue = result[OFFLINE_QUEUE_KEY] || [];
    } catch (error) {
      console.error('[SyncManager] Failed to load offline queue:', error);
      this.offlineQueue = [];
    }
  }

  /**
   * Save offline queue to storage
   */
  async saveOfflineQueue() {
    try {
      await chrome.storage.local.set({ [OFFLINE_QUEUE_KEY]: this.offlineQueue });
    } catch (error) {
      console.error('[SyncManager] Failed to save offline queue:', error);
    }
  }

  /**
   * Handle coming online
   */
  handleOnline() {
    console.log('[SyncManager] Online - processing queue');
    this.processOfflineQueue();
  }

  /**
   * Handle going offline
   */
  handleOffline() {
    console.log('[SyncManager] Offline');
    // Cancel any in-progress operations gracefully
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Execute function with retry logic
   */
  async withRetry(fn, retries = MAX_RETRIES) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        console.warn(`[SyncManager] Attempt ${attempt}/${retries} failed:`, error.message);

        if (attempt < retries && this.shouldRetry(error)) {
          await this.delay(RETRY_DELAY_MS * attempt);
        }
      }
    }

    throw lastError;
  }

  /**
   * Check if error should trigger retry
   */
  shouldRetry(error) {
    // Retry on network errors or 5xx server errors
    if (!navigator.onLine) return true;
    if (error.status >= 500) return true;
    if (error.message?.includes('network') || error.message?.includes('fetch')) return true;

    // Don't retry on auth errors or client errors
    if (error.status === 401 || error.status === 403) return false;
    if (error.status >= 400 && error.status < 500) return false;

    return true;
  }

  /**
   * Delay utility
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Split array into chunks
   */
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Notify progress (for UI updates)
   */
  notifyProgress(progress) {
    // Direct callback for the background context (sendMessage below is not
    // delivered to the sender's own context).
    try {
      this.onProgress?.(progress);
    } catch (error) {
      console.error('[SyncManager] onProgress callback failed:', error);
    }

    // Send message to popup or content script
    chrome.runtime.sendMessage({
      type: 'SYNC_PROGRESS',
      data: progress
    }).catch(() => {
      // Ignore if no listeners
    });
  }
}

export default SyncManager;
