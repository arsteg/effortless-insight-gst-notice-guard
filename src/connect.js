/**
 * GST Notice Guard - Web App Connector
 * Runs ONLY on the EffortlessInsight web app. When the extension's background
 * worker asks (user clicked "Use my EffortlessInsight session" in the popup),
 * it hands over the tokens of the already-signed-in web session so users who
 * authenticate via Google/OAuth can sign in to the extension without a password.
 *
 * Messages arrive via chrome.runtime.onMessage, which only the extension
 * itself can send to a content script — web pages cannot trigger this.
 */

const ACCESS_TOKEN_KEY = 'access_token';
const REFRESH_TOKEN_KEY = 'refresh_token';

function readSession() {
  try {
    const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!accessToken || !refreshToken) return null;
    return { accessToken, refreshToken };
  } catch (error) {
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'EI_GET_SESSION') {
    return false;
  }

  const session = readSession();
  if (!session) {
    sendResponse({ success: false, error: 'NOT_SIGNED_IN' });
  } else {
    sendResponse({ success: true, ...session });
  }

  return false; // Responded synchronously
});

/**
 * Proactively offer the session so the extension can sign itself in with no
 * popup interaction. The background ignores the push when it is already
 * signed in, and validates the tokens against its selected API environment
 * before accepting them.
 */
function offerSession() {
  const session = readSession();
  if (!session) return;

  chrome.runtime.sendMessage({ type: 'EI_SESSION_PUSH', data: session }).catch(() => {
    // Background not ready / extension reloading — harmless
  });
}

offerSession();
// The app hydrates asynchronously after OAuth redirects; try once more shortly.
setTimeout(offerSession, 5000);

console.log('[GST Guard] Web app connector ready');
