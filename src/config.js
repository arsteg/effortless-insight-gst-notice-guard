/**
 * GST Notice Guard - Configuration
 * Single source of truth for which EffortlessInsight backend the extension talks to.
 *
 * The selected environment is stored in chrome.storage.local and resolved
 * dynamically on each request, so switching in the popup takes effect
 * immediately without reloading the extension.
 */

export const API_ENVIRONMENTS = {
  live: {
    label: 'Live (api.effortlessinsight.in)',
    baseUrl: 'https://api.effortlessinsight.in/api/v1',
    webUrl: 'https://app.effortlessinsight.in',
  },
  // BUILD:DEV-ONLY-START — stripped from release builds by tools/build-release.js
  local: {
    label: 'Local (localhost:59110)',
    baseUrl: 'https://localhost:59110/api/v1',
    webUrl: 'http://localhost:3000',
  },
  // BUILD:DEV-ONLY-END
};

export const DEFAULT_ENVIRONMENT = 'live';

const STORAGE_KEY = 'apiEnvironment';

/**
 * Get the currently selected environment key (falls back to the default
 * if nothing valid is stored).
 */
export async function getApiEnvironment() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const env = stored[STORAGE_KEY];
  return API_ENVIRONMENTS[env] ? env : DEFAULT_ENVIRONMENT;
}

/**
 * Get the API base URL (including the /api/v1 suffix) for the selected environment.
 */
export async function getApiBaseUrl() {
  const env = await getApiEnvironment();
  return API_ENVIRONMENTS[env].baseUrl;
}

/**
 * Get the web app URL for the selected environment (used to borrow the
 * user's existing browser session for extension sign-in).
 */
export async function getWebUrl() {
  const env = await getApiEnvironment();
  return API_ENVIRONMENTS[env].webUrl;
}

/**
 * Persist the selected environment. Throws on an unknown key.
 */
export async function setApiEnvironment(env) {
  if (!API_ENVIRONMENTS[env]) {
    throw new Error(`Unknown API environment: ${env}`);
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: env });
  return env;
}
