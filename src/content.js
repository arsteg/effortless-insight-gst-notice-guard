/**
 * GST Notice Guard - Content Script
 * Runs on GST portal pages to detect login and capture notices
 * Includes enhanced DOM parsing for various notice types
 */

// ============================================================================
// Constants and Selectors
// ============================================================================

// Known GST Portal URL patterns
const PAGE_PATTERNS = {
  ADDITIONAL_NOTICES: /view-additional-notices/i,
  DEMAND_NOTICES: /demand.*notice|drc/i,
  ASSESSMENT_NOTICES: /assessment.*notice|asmt/i,
  REGISTRATION_NOTICES: /registration.*notice|reg/i,
  REFUND_NOTICES: /refund.*notice|rfd/i,
  ALL_NOTICES: /notices|case-details/i,
  NOTICE_DETAIL: /notice-detail|view-notice|show-notice/i,
  CASE_DETAIL: /case-detail|case-view/i,
  DASHBOARD: /dashboard|taxpayerdashboard/i,
  LOGIN: /login|auth/i
};

// DOM Selector configurations for different page types
const SELECTORS = {
  COMMON: {
    gstinHeader: [
      '.gstin-display',
      '#gstin',
      '[data-gstin]',
      '.user-gstin',
      'span[class*="gstin"]',
      'div[class*="gstin"] span'
    ],
    noticeTable: [
      'table.table',
      '#noticeTable',
      '.notice-table',
      'table[id*="notice"]',
      'table[class*="notice"]',
      '.dataTables_wrapper table',
      '#DataTables_Table_0'
    ],
    tableRows: 'tbody tr:not(.no-data)',
    pagination: '.pagination, .dataTables_paginate'
  },

  DRC: {
    table: '#drcNoticeTable, table[id*="drc"]',
    columns: {
      noticeId: 0,
      noticeType: 1,
      referenceNo: 2,
      issueDate: 3,
      dueDate: 4,
      demandAmount: 5,
      status: 6,
      action: 7
    }
  },

  ASMT: {
    table: '#asmtNoticeTable, table[id*="asmt"]',
    columns: {
      noticeId: 0,
      noticeType: 1,
      taxPeriod: 2,
      issueDate: 3,
      dueDate: 4,
      status: 5,
      action: 6
    }
  },

  REG: {
    table: '#regNoticeTable, table[id*="reg"]',
    columns: {
      noticeId: 0,
      noticeType: 1,
      issueDate: 2,
      dueDate: 3,
      status: 4,
      action: 5
    }
  },

  GENERIC: {
    table: 'table.table, .notice-table',
    columns: {
      noticeId: 0,
      noticeType: 1,
      issueDate: 2,
      dueDate: 3,
      amount: 4,
      status: 5,
      action: -1
    }
  }
};

// Notice detail page field mappings
const DETAIL_FIELD_LABELS = {
  noticeId: ['Notice ID', 'Notice No', 'DRC No', 'Reference No', 'ARN'],
  referenceNumber: ['Reference Number', 'Ref No', 'Reference'],
  noticeType: ['Notice Type', 'Type of Notice', 'Form Type'],
  issueDate: ['Issue Date', 'Date of Issue', 'Notice Date'],
  dueDate: ['Due Date', 'Response Due', 'Reply Due', 'Last Date'],
  demandAmount: ['Total Demand', 'Demand Amount', 'Total Amount', 'Amount'],
  taxAmount: ['Tax Amount', 'Tax', 'IGST', 'CGST', 'SGST'],
  interestAmount: ['Interest', 'Interest Amount'],
  penaltyAmount: ['Penalty', 'Penalty Amount', 'Late Fee'],
  taxPeriod: ['Tax Period', 'Period', 'Return Period'],
  financialYear: ['Financial Year', 'FY', 'F.Y.'],
  section: ['Section', 'Under Section', 'Act Section'],
  officerName: ['Officer Name', 'Issuing Officer', 'Issued By'],
  designation: ['Designation', 'Officer Designation'],
  jurisdiction: ['Jurisdiction', 'Ward', 'Division', 'Range'],
  status: ['Status', 'Notice Status', 'Current Status']
};

// Notice type mappings for normalization
const NOTICE_TYPE_MAPPINGS = {
  'DRC-01': ['DRC01', 'DRC 01', 'FORM DRC-01'],
  'DRC-01A': ['DRC01A', 'DRC 01A'],
  'DRC-01B': ['DRC01B', 'DRC 01B'],
  'DRC-07': ['DRC07', 'DRC 07'],
  'ASMT-10': ['ASMT10', 'ASMT 10', 'FORM ASMT-10'],
  'ASMT-12': ['ASMT12', 'ASMT 12'],
  'REG-17': ['REG17', 'REG 17'],
  'REG-31': ['REG31', 'REG 31'],
  'RFD-08': ['RFD08', 'RFD 08']
};

// ============================================================================
// Configuration - Can be updated from server
// ============================================================================

let CONFIG = {
  selectors: SELECTORS.COMMON,
  enabledGstins: [],
  autoCapture: true,
  captureOnNoticesPage: true,
  autoDownloadPdf: false
};

// State
let isAuthenticated = false;
let currentGstin = null;
let currentTradeName = null;
let capturedNotices = [];
let currentPageType = null;

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  console.log('[GST Guard] Initializing on:', window.location.href);

  // Check if extension is authenticated
  const authState = await sendMessage({ type: 'GET_AUTH_STATE' });
  isAuthenticated = authState.isLoggedIn;

  if (!isAuthenticated) {
    console.log('[GST Guard] Not authenticated, skipping');
    return;
  }

  // Load configuration from backend
  const config = await sendMessage({ type: 'GET_CONFIG' });
  if (config) {
    CONFIG = { ...CONFIG, ...config };
    // Merge server selectors with our defaults
    if (config.selectors) {
      CONFIG.selectors = { ...SELECTORS.COMMON, ...config.selectors };
    }
  }

  // Detect current page type and act accordingly
  detectPageTypeAndProcess();

  // Watch for SPA navigation
  observeUrlChanges();

  // Watch for dynamic content
  observeDomChanges();
}

// ============================================================================
// Page Detection
// ============================================================================

function detectPageType() {
  const url = window.location.href;
  const path = window.location.pathname;

  for (const [type, pattern] of Object.entries(PAGE_PATTERNS)) {
    if (pattern.test(url) || pattern.test(path)) {
      currentPageType = type;
      return type;
    }
  }

  // Check page content
  if (findNoticeTable()) {
    currentPageType = 'NOTICE_LIST';
    return 'NOTICE_LIST';
  }

  if (findNoticeDetailFields()) {
    currentPageType = 'NOTICE_DETAIL';
    return 'NOTICE_DETAIL';
  }

  return null;
}

function detectPageTypeAndProcess() {
  const pageType = detectPageType();

  if (pageType === 'LOGIN') {
    watchForLogin();
    return;
  }

  if (pageType === 'DASHBOARD' || isDashboardPage()) {
    detectLoggedInGstin();
    if (currentGstin) {
      sendMessage({ type: 'GST_LOGIN_DETECTED', data: { gstin: currentGstin, url: window.location.href } });
      // The notices API returns all notices regardless of the current page, so
      // we can capture proactively as soon as a logged-in GSTIN is detected —
      // no need to wait for the user to open the notices screen.
      if (CONFIG.autoCapture) {
        captureNoticesFromPage();
      }
    }
  }

  if (isNoticesPage(pageType)) {
    console.log('[GST Guard] Notices page detected:', pageType);
    if (CONFIG.captureOnNoticesPage) {
      setTimeout(() => captureNoticesFromPage(), 1500);
    }
  }

  if (pageType === 'NOTICE_DETAIL' || pageType === 'CASE_DETAIL') {
    console.log('[GST Guard] Notice detail page detected');
    captureNoticeDetail();
  }
}

function isNoticesPage(pageType) {
  return ['ADDITIONAL_NOTICES', 'DEMAND_NOTICES', 'ASSESSMENT_NOTICES',
          'REGISTRATION_NOTICES', 'REFUND_NOTICES', 'ALL_NOTICES', 'NOTICE_LIST'].includes(pageType);
}

function isDashboardPage() {
  return document.querySelector('.user-gstin, [class*="gstin"], #gstin') !== null ||
         window.location.pathname.includes('dashboard');
}

// ============================================================================
// Notice Table Detection
// ============================================================================

function findNoticeTable() {
  const selectors = CONFIG.selectors.noticeTable || SELECTORS.COMMON.noticeTable;

  for (const selector of selectors) {
    const table = document.querySelector(selector);
    if (table && table.querySelector('tbody tr')) {
      return table;
    }
  }
  return null;
}

function findNoticeDetailFields() {
  const indicators = ['Notice ID', 'Notice Type', 'Issue Date', 'Reference Number'];
  const pageText = document.body.innerText;
  const matchCount = indicators.filter(i => pageText.includes(i)).length;
  return matchCount >= 2;
}

function detectNoticeTypeFromPage() {
  const url = window.location.href.toLowerCase();
  const pageText = document.body.innerText.substring(0, 5000).toLowerCase();

  if (url.includes('drc') || pageText.includes('demand and recovery')) return 'DRC';
  if (url.includes('asmt') || pageText.includes('assessment')) return 'ASMT';
  if (url.includes('reg') || pageText.includes('registration')) return 'REG';
  if (url.includes('rfd') || pageText.includes('refund')) return 'RFD';
  return 'GENERIC';
}

// ============================================================================
// Login Detection
// ============================================================================

function watchForLogin() {
  const observer = new MutationObserver(() => {
    if (isDashboardPage()) {
      detectLoggedInGstin();
      if (currentGstin) {
        sendMessage({ type: 'GST_LOGIN_DETECTED', data: { gstin: currentGstin } });
      }
      observer.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function detectLoggedInGstin() {
  const selectors = SELECTORS.COMMON.gstinHeader;

  for (const selector of selectors) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        const text = element.textContent || element.getAttribute('data-gstin') || '';
        const gstinMatch = text.match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[A-Z0-9]{1}/);
        if (gstinMatch) {
          currentGstin = gstinMatch[0];
          console.log('[GST Guard] Detected GSTIN:', currentGstin);
          return;
        }
      }
    } catch (e) {
      // Selector might be invalid
    }
  }

  // Fallback: search page text
  const pageText = document.body.innerText.substring(0, 10000);
  const gstinMatch = pageText.match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[A-Z0-9]{1}/);
  if (gstinMatch) {
    currentGstin = gstinMatch[0];
    console.log('[GST Guard] Detected GSTIN from page text:', currentGstin);
  }
}

/**
 * Best-effort trade name detection: the portal header shows the trade name
 * directly above/beside the logged-in GSTIN. Returns null when unsure —
 * the backend treats it as optional.
 */
function detectTradeName() {
  if (!currentGstin) return null;

  try {
    // Find the smallest element whose text contains the GSTIN, then look at
    // the surrounding container's text with the GSTIN stripped out.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.includes(currentGstin)) continue;

      const container = node.parentElement?.closest('div, li, header, span') || node.parentElement;
      if (!container) continue;

      const text = (container.innerText || '')
        .replace(currentGstin, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Plausible trade name: short, not a sentence, not portal chrome
      if (text && text.length >= 3 && text.length <= 100 && !/dashboard|login|logout|welcome/i.test(text)) {
        return text;
      }
    }
  } catch (e) {
    // Non-critical
  }
  return null;
}

// ============================================================================
// Notice List Parsing
// ============================================================================

// Portal internal notices endpoint (discovered via network capture).
// Returns the taxpayer's notices as structured JSON — preferred over scraping.
const NOTICES_API_URL = 'https://services.gst.gov.in/services/auth/api/get/notices';

// Map the portal's application code (applnCd) to our normalized notice type.
const APPLN_CD_TYPE_MAP = {
  APL3A: 'GSTR-3A'
};

/**
 * Capture notices: try the portal's JSON endpoint first, fall back to scraping
 * the visible table, then sync whatever we found.
 */
async function captureNoticesFromPage() {
  console.log('[GST Guard] Capturing notices...');

  // Primary path: the portal's own JSON endpoint.
  let notices = await fetchNoticesFromApi();
  let source = 'portal_api';

  // Fallback path: scrape the visible table if the API path yielded nothing.
  if (!notices || notices.length === 0) {
    notices = captureNoticesFromDom();
    source = 'dom_scrape';
  }

  if (!notices || notices.length === 0) {
    console.log('[GST Guard] No notices found (API or DOM)');
    return;
  }

  capturedNotices = notices;
  console.log(`[GST Guard] Captured ${notices.length} notices via ${source}`);

  // Notify background
  await sendMessage({ type: 'NOTICES_CAPTURED', data: { notices, gstin: currentGstin } });

  // Show visual indicator
  showSyncIndicator(`Captured ${notices.length} notices`);

  // Auto-sync if enabled
  if (CONFIG.autoCapture) {
    await syncCapturedNotices();
  }
}

/**
 * Fetch notices from the GST portal's internal JSON endpoint.
 * Runs inside the user's authenticated session (cookies sent via credentials).
 * Returns an array of mapped notices, or null if the call failed or the
 * response shape was unexpected — the caller then falls back to DOM scraping.
 */
async function fetchNoticesFromApi() {
  try {
    const response = await fetch(NOTICES_API_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onLoad: true })
    });

    if (!response.ok) {
      console.warn('[GST Guard] Notices API returned HTTP', response.status);
      return null;
    }

    const data = await response.json();
    // The endpoint returns a bare array; also accept a { data: [...] } envelope.
    const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
    if (!list) {
      console.warn('[GST Guard] Notices API returned an unexpected shape');
      return null;
    }

    const notices = list.map(mapApiNotice).filter(n => n && n.portalNoticeId);
    console.log(`[GST Guard] Notices API returned ${list.length} row(s), mapped ${notices.length}`);
    return notices;
  } catch (error) {
    console.warn('[GST Guard] Notices API call failed, falling back to DOM:', error);
    return null;
  }
}

/**
 * Map one raw notice object from the portal API to our internal notice shape.
 */
function mapApiNotice(raw) {
  if (!raw || !raw.noticeOrderId) return null;

  const noticeOrderId = String(raw.noticeOrderId).trim();
  const amountStr = raw.amount;
  const hasAmount = amountStr && !/^(na|n\/a)$/i.test(String(amountStr).trim());

  return {
    portalNoticeId: noticeOrderId,
    referenceNumber: noticeOrderId,
    noticeType: deriveNoticeTypeFromApi(raw),
    issueDate: parseDate(raw.dtOfIssue),
    dueDate: parseDate(raw.dueDate),
    statusOnPortal: raw.status || raw.authStatus || null,
    demandAmount: hasAmount ? parseAmount(amountStr) : null,
    officerName: raw.issuedBy || null,
    sectionRule: extractSection(raw.descr),
    pdfAvailable: !!raw.pdfDownloadURL,
    // Feeds SyncManager.handlePdfDownloads: the PDF is fetched inside the
    // user's portal session, uploaded to S3 via a presigned URL, and then
    // drives AI analysis on import.
    pdfLink: raw.pdfDownloadURL ? toAbsolutePortalUrl(raw.pdfDownloadURL) : null,
    pdfDownload: raw.pdfDownloadURL ? {
      url: raw.pdfDownloadURL,
      appDefId: raw.appDefId || null,
      noticeOrderId,
      dtOfIssue: raw.dtOfIssue || null
    } : null,
    rawData: {
      source: 'portal_api',
      capturedAt: new Date().toISOString(),
      gstin: currentGstin,
      descr: raw.descr || null,
      raw
    }
  };
}

/**
 * Best-effort notice-type resolution from the portal's fields.
 */
function deriveNoticeTypeFromApi(raw) {
  const code = (raw.applnCd || '').toUpperCase().trim();
  if (APPLN_CD_TYPE_MAP[code]) return APPLN_CD_TYPE_MAP[code];

  const normalized = normalizeNoticeType(raw.descr || '');
  if (/^(DRC|ASMT|REG|RFD|ADJ)-/.test(normalized)) return normalized;

  return code || 'OTHER';
}

/**
 * The portal's pdfDownloadURL may be relative — resolve against the portal origin.
 */
function toAbsolutePortalUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  return 'https://services.gst.gov.in' + (url.startsWith('/') ? '' : '/') + url;
}

/**
 * Extract a section reference (e.g. "Section 46") from a notice description.
 */
function extractSection(descr) {
  if (!descr) return null;
  const match = descr.match(/u\/s\s*(\d+[A-Za-z]?)/i) || descr.match(/section\s*(\d+[A-Za-z]?)/i);
  return match ? `Section ${match[1]}` : null;
}

/**
 * Fallback: scrape notices from the visible DOM table.
 * Returns an array of notices (may be empty).
 */
function captureNoticesFromDom() {
  const table = findNoticeTable();
  if (!table) {
    console.log('[GST Guard] No notice table found for DOM scraping');
    return [];
  }

  const rows = table.querySelectorAll(SELECTORS.COMMON.tableRows);
  const noticeType = detectNoticeTypeFromPage();
  const notices = [];

  console.log('[GST Guard] DOM scraping', rows.length, 'rows, notice type:', noticeType);

  rows.forEach((row, index) => {
    try {
      const notice = parseTableRow(row, index, noticeType);
      if (notice && notice.portalNoticeId) {
        notices.push(notice);
      }
    } catch (error) {
      console.error('[GST Guard] Error parsing row', index, error);
    }
  });

  return notices;
}

function parseTableRow(row, index, noticeType = 'GENERIC') {
  const cells = row.querySelectorAll('td');
  if (cells.length < 3) return null;

  const config = SELECTORS[noticeType] || SELECTORS.GENERIC;
  const cols = config.columns || SELECTORS.GENERIC.columns;

  const getCellText = (colIndex) => {
    if (colIndex < 0) colIndex = cells.length + colIndex;
    if (colIndex >= cells.length || colIndex < 0) return null;
    return cells[colIndex]?.innerText?.trim() || null;
  };

  const findLink = () => {
    const link = row.querySelector('a[href*="notice"], a[href*="view"], a[onclick]');
    return link?.href || link?.getAttribute('onclick') || null;
  };

  const findPdfLink = () => {
    const pdfLink = row.querySelector('a[href*=".pdf"], a[href*="download"], a[title*="PDF"], a[title*="Download"]');
    return pdfLink?.href || null;
  };

  const notice = {
    portalNoticeId: cleanNoticeId(getCellText(cols.noticeId)),
    referenceNumber: getCellText(cols.referenceNo) || null,
    noticeType: normalizeNoticeType(getCellText(cols.noticeType) || noticeType),
    issueDate: parseDate(getCellText(cols.issueDate)),
    dueDate: parseDate(getCellText(cols.dueDate)),
    demandAmount: parseAmount(getCellText(cols.demandAmount || cols.amount)),
    statusOnPortal: getCellText(cols.status),
    taxPeriod: getCellText(cols.taxPeriod) || null,
    pdfAvailable: !!findPdfLink(),
    detailLink: findLink(),
    pdfLink: findPdfLink(),
    rawData: {
      rowIndex: index,
      // Store a trimmed text snapshot rather than untrusted portal HTML.
      text: (row.innerText || '').trim().slice(0, 2000),
      url: window.location.href,
      capturedAt: new Date().toISOString()
    }
  };

  return notice;
}

// ============================================================================
// Notice Detail Parsing
// ============================================================================

function captureNoticeDetail() {
  const notice = {
    rawData: {
      url: window.location.href,
      capturedAt: new Date().toISOString()
    }
  };

  // Extract each field using label matching
  for (const [field, labels] of Object.entries(DETAIL_FIELD_LABELS)) {
    const value = findFieldValue(labels);
    if (value) {
      switch (field) {
        case 'noticeId':
          notice.portalNoticeId = cleanNoticeId(value);
          break;
        case 'issueDate':
        case 'dueDate':
          notice[field] = parseDate(value);
          break;
        case 'demandAmount':
        case 'taxAmount':
        case 'interestAmount':
        case 'penaltyAmount':
          notice[field] = parseAmount(value);
          break;
        case 'noticeType':
          notice[field] = normalizeNoticeType(value);
          break;
        default:
          notice[field] = value;
      }
    }
  }

  // Check for PDF
  notice.pdfAvailable = !!document.querySelector('a[href*=".pdf"], a[href*="download"], button[onclick*="pdf"]');
  notice.pdfLink = document.querySelector('a[href*=".pdf"]')?.href || null;

  // Store a trimmed text snapshot rather than untrusted portal HTML.
  notice.rawData.text = (document.body.innerText || '').trim().slice(0, 5000);

  if (notice.portalNoticeId) {
    capturedNotices.push(notice);
    console.log('[GST Guard] Captured notice detail:', notice.portalNoticeId);

    // Notify and sync
    sendMessage({ type: 'NOTICES_CAPTURED', data: { notices: [notice], gstin: currentGstin } });

    if (CONFIG.autoCapture) {
      syncCapturedNotices();
    }
  }
}

function findFieldValue(labels) {
  for (const label of labels) {
    // Try table row with label
    const rows = document.querySelectorAll('tr');
    for (const row of rows) {
      const firstCell = row.querySelector('td, th');
      if (firstCell?.innerText?.toLowerCase().includes(label.toLowerCase())) {
        const valueCell = row.querySelector('td:last-child, td:nth-child(2)');
        if (valueCell && valueCell !== firstCell) {
          const text = valueCell.innerText?.trim();
          if (text) return text;
        }
      }
    }

    // Try label + value divs
    const labelElements = document.querySelectorAll('label, .label, [class*="label"]');
    for (const el of labelElements) {
      if (el.innerText?.toLowerCase().includes(label.toLowerCase())) {
        const next = el.nextElementSibling;
        if (next) {
          const text = next.innerText?.trim();
          if (text) return text;
        }

        const parent = el.parentElement;
        const value = parent?.querySelector('.value, [class*="value"], span:not([class*="label"])');
        if (value) {
          const text = value.innerText?.trim();
          if (text) return text;
        }
      }
    }
  }
  return null;
}

// ============================================================================
// Sync to Backend
// ============================================================================

async function syncCapturedNotices() {
  if (capturedNotices.length === 0) {
    console.log('[GST Guard] No notices to sync');
    return;
  }

  if (!currentGstin) {
    console.log('[GST Guard] No GSTIN detected, cannot sync');
    return;
  }

  // Check if GSTIN is enabled for sync
  if (CONFIG.enabledGstins?.length > 0 && !CONFIG.enabledGstins.includes(currentGstin)) {
    console.log('[GST Guard] GSTIN not enabled for sync:', currentGstin);
    return;
  }

  // First-time gate: this GSTIN must be explicitly linked to the user's
  // workspace before anything is synced. Instead of failing silently (or
  // syncing into whatever organization happens to be active), ask.
  const gstClient = await sendMessage({ type: 'GET_GST_CLIENT', data: { gstin: currentGstin } })
    .catch(() => null);

  if (!gstClient) {
    await promptToLinkGstin();
    return;
  }

  showSyncIndicator('Syncing notices...', 'syncing');

  try {
    const syncResult = await sendMessage({
      type: 'SYNC_NOTICES_DIRECT',
      data: {
        gstin: currentGstin,
        notices: capturedNotices,
        pageUrl: window.location.href
      }
    });

    console.log('[GST Guard] Sync result:', syncResult);

    if (syncResult.success) {
      showSyncIndicator(`Synced ${capturedNotices.length} notices`, 'success');
      capturedNotices = [];
    } else if (syncResult.queued) {
      showSyncIndicator('Notices queued for sync', 'success');
      capturedNotices = [];
    } else {
      showSyncIndicator(syncResult.error || 'Sync failed', 'error');
    }

  } catch (error) {
    console.error('[GST Guard] Sync failed:', error);
    showSyncIndicator('Sync failed: ' + error.message, 'error');
  }
}

// ============================================================================
// First-time GSTIN Link Confirmation
// ============================================================================

const LINK_PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function linkPromptSnoozeKey(orgId, gstin) {
  return `gst_guard_link_snoozed_${orgId || 'unknown'}_${gstin}`;
}

/**
 * Ask the user to confirm linking the detected GSTIN to their workspace
 * before the first sync. Shows GSTIN, trade name (from the portal page) and
 * the TARGET ORGANIZATION by name, so a CA who belongs to several
 * organizations can catch an active-org mismatch before any data moves.
 */
async function promptToLinkGstin() {
  // Only one prompt at a time
  if (document.querySelector('.gst-guard-link-prompt')) return;

  const authState = await sendMessage({ type: 'GET_AUTH_STATE' }).catch(() => null);
  if (!authState?.isLoggedIn) return;

  const orgId = authState.organization?.id || null;
  const orgName = authState.organization?.name || 'your workspace';

  // Respect an earlier "Not now" for this org+GSTIN
  const snoozeKey = linkPromptSnoozeKey(orgId, currentGstin);
  try {
    const stored = await chrome.storage.local.get(snoozeKey);
    const snoozedAt = stored[snoozeKey];
    if (snoozedAt && Date.now() - snoozedAt < LINK_PROMPT_SNOOZE_MS) {
      console.log('[GST Guard] Link prompt snoozed for', currentGstin);
      return;
    }
  } catch (e) {
    // Storage failure is non-fatal; fall through and show the prompt
  }

  currentTradeName = currentTradeName || detectTradeName();

  // Build with DOM APIs — trade name and org name are untrusted text.
  const card = document.createElement('div');
  card.className = 'gst-guard-link-prompt';

  const title = document.createElement('div');
  title.className = 'gst-guard-link-title';
  title.textContent = 'Link this GSTIN to EffortlessInsight?';

  const body = document.createElement('div');
  body.className = 'gst-guard-link-body';

  const gstinLine = document.createElement('div');
  gstinLine.className = 'gst-guard-link-gstin';
  gstinLine.textContent = currentTradeName
    ? `${currentTradeName} (${currentGstin})`
    : currentGstin;

  const orgLine = document.createElement('div');
  orgLine.className = 'gst-guard-link-org';
  orgLine.textContent = `Notices will sync into workspace: ${orgName}`;

  const hint = document.createElement('div');
  hint.className = 'gst-guard-link-hint';
  hint.textContent = 'Wrong workspace? Switch organization in EffortlessInsight, then sign in to the extension again.';

  body.append(gstinLine, orgLine, hint);

  const actions = document.createElement('div');
  actions.className = 'gst-guard-link-actions';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'gst-guard-btn gst-guard-btn-primary';
  confirmBtn.textContent = 'Link & start syncing';

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'gst-guard-btn gst-guard-btn-ghost';
  dismissBtn.textContent = 'Not now';

  actions.append(confirmBtn, dismissBtn);
  card.append(title, body, actions);
  document.body.appendChild(card);

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    dismissBtn.disabled = true;
    confirmBtn.textContent = 'Linking...';

    try {
      const result = await sendMessage({
        type: 'REGISTER_GST_CLIENT',
        data: { gstin: currentGstin, tradeName: currentTradeName }
      });

      card.remove();

      if (result?.success) {
        showSyncIndicator('GSTIN linked to ' + orgName, 'success');
        // Now that the client exists, run the sync that was gated
        await syncCapturedNotices();
      } else {
        showSyncIndicator(result?.error || 'Could not link GSTIN', 'error');
      }
    } catch (error) {
      card.remove();
      showSyncIndicator('Could not link GSTIN: ' + error.message, 'error');
    }
  });

  dismissBtn.addEventListener('click', async () => {
    card.remove();
    try {
      await chrome.storage.local.set({ [snoozeKey]: Date.now() });
    } catch (e) {
      // Non-fatal
    }
    console.log('[GST Guard] User dismissed link prompt for', currentGstin);
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

function cleanNoticeId(id) {
  if (!id) return null;
  return id.replace(/^(notice\s*id|ref|arn)[\s:.-]*/i, '').trim();
}

function normalizeNoticeType(type) {
  if (!type) return 'OTHER';

  type = type.toUpperCase().trim();

  for (const [standard, variations] of Object.entries(NOTICE_TYPE_MAPPINGS)) {
    if (type === standard || variations.includes(type)) {
      return standard;
    }
  }

  // Try to extract form number
  const match = type.match(/(DRC|ASMT|REG|RFD|ADJ)[\s-]*(\d+[A-Z]?)/i);
  if (match) {
    return `${match[1].toUpperCase()}-${match[2].toUpperCase()}`;
  }

  return type;
}

function parseDate(dateStr) {
  if (!dateStr) return null;

  dateStr = dateStr.trim();

  const patterns = [
    // Numeric DMY: accepts / - or . separators and single-digit day/month
    // (e.g. 1/2/2024, 01-02-2024, 15.03.2024).
    { regex: /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/, format: 'DMY' },
    { regex: /(\d{4})-(\d{2})-(\d{2})/, format: 'YMD' },
    { regex: /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i, format: 'DMY_TEXT' }
  ];

  for (const { regex, format } of patterns) {
    const match = dateStr.match(regex);
    if (match) {
      let year, month, day;

      if (format === 'DMY') {
        [, day, month, year] = match;
        // Zero-pad single-digit day/month to keep YYYY-MM-DD output.
        day = day.padStart(2, '0');
        month = month.padStart(2, '0');
      } else if (format === 'YMD') {
        [, year, month, day] = match;
      } else if (format === 'DMY_TEXT') {
        [, day, month, year] = match;
        const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                        jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
        month = months[month.toLowerCase().substring(0, 3)];
        day = day.padStart(2, '0');
      }

      return `${year}-${month}-${day}`;
    }
  }

  return null;
}

function parseAmount(amountStr) {
  if (!amountStr) return null;

  const cleaned = amountStr.replace(/[₹$,\s]/g, '').replace(/[^\d.-]/g, '');
  const amount = parseFloat(cleaned);

  return isNaN(amount) ? null : amount;
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
// Visual Feedback
// ============================================================================

function showSyncIndicator(message, status = 'syncing') {
  // Remove existing indicator
  const existing = document.querySelector('.gst-guard-sync-indicator');
  if (existing) existing.remove();

  const indicator = document.createElement('div');
  indicator.className = `gst-guard-sync-indicator ${status}`;

  if (status === 'syncing') {
    indicator.innerHTML = `<div class="spinner"></div><span>${message}</span>`;
  } else {
    indicator.innerHTML = `<span>${message}</span>`;
  }

  document.body.appendChild(indicator);

  // Auto-hide after delay
  if (status !== 'syncing') {
    setTimeout(() => {
      indicator.style.opacity = '0';
      setTimeout(() => indicator.remove(), 300);
    }, 3000);
  }

  return indicator;
}

function hideSyncIndicator() {
  const indicator = document.querySelector('.gst-guard-sync-indicator');
  if (indicator) indicator.remove();
}

// ============================================================================
// Observers
// ============================================================================

function observeUrlChanges() {
  let lastUrl = window.location.href;

  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      console.log('[GST Guard] URL changed to:', lastUrl);
      setTimeout(() => detectPageTypeAndProcess(), 500);
    }
  });

  observer.observe(document, { subtree: true, childList: true });

  window.addEventListener('popstate', () => {
    console.log('[GST Guard] Popstate event');
    setTimeout(() => detectPageTypeAndProcess(), 500);
  });
}

function observeDomChanges() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Check if notice table was added
          const tableSelectors = SELECTORS.COMMON.noticeTable;
          for (const selector of tableSelectors) {
            try {
              if (node.matches?.(selector) || node.querySelector?.(selector)) {
                console.log('[GST Guard] Notice table dynamically loaded');
                setTimeout(() => captureNoticesFromPage(), 500);
                return;
              }
            } catch (e) {
              // Invalid selector
            }
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ============================================================================
// Initialize
// ============================================================================

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

console.log('[GST Guard] Content script loaded');
