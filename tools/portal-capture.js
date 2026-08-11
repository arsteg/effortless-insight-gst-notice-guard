/**
 * GST Notice Guard - Portal Endpoint Capture
 * ------------------------------------------------------------
 * A one-time discovery tool. Paste this whole file into the DevTools
 * Console while logged into the GST portal, then browse the notices
 * pages. It wraps fetch() and XMLHttpRequest to record which internal
 * JSON endpoints the portal calls, plus the SHAPE of each request and
 * response (field names and types) — NOT the actual values.
 *
 * Because it records shapes, not values, the output is safe to share:
 * it contains no GSTINs, amounts, names, or notice contents.
 *
 * Usage:
 *   1. Paste and press Enter. You'll see "[capture] armed".
 *   2. Navigate the notices pages (see CAPTURE-RUNBOOK.md).
 *   3. Run:  __gstCapture.dump()      // prints a summary table
 *   4. Run:  __gstCapture.copy()      // copies full JSON to clipboard
 *   5. Run:  __gstCapture.stop()      // restores the originals
 *
 * Nothing here talks to the network or the extension — it only observes.
 */
(() => {
  if (window.__gstCapture) {
    console.warn('[capture] already armed — run __gstCapture.stop() first to re-arm');
    return;
  }

  const MAX_DEPTH = 6;
  const MAX_ARRAY_SAMPLE = 3;   // shapes of first N array elements are merged
  const MAX_KEYS = 60;          // guard against pathological objects

  // Only record calls that look like data endpoints, not static assets.
  const IGNORE = /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i;
  const isInteresting = (url) => !!url && !IGNORE.test(url);

  // Records keyed by "METHOD path" so repeated calls collapse into one entry.
  const records = new Map();

  /** Reduce any JSON value to a structural descriptor (no leaf values). */
  function shapeOf(value, depth = 0) {
    if (value === null) return 'null';
    if (depth >= MAX_DEPTH) return '…';
    const t = typeof value;
    if (t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'string') {
      // Keep a couple of format hints that help field-mapping without leaking data.
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'string(date)';
      if (/^\d+(\.\d+)?$/.test(value)) return 'string(numeric)';
      return 'string';
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return ['(empty)'];
      const merged = {};
      value.slice(0, MAX_ARRAY_SAMPLE).forEach((el) => {
        const s = shapeOf(el, depth + 1);
        if (s && typeof s === 'object' && !Array.isArray(s)) Object.assign(merged, s);
      });
      const firstShape = shapeOf(value[0], depth + 1);
      return Object.keys(merged).length ? [merged] : [firstShape];
    }
    if (t === 'object') {
      const out = {};
      const keys = Object.keys(value).slice(0, MAX_KEYS);
      for (const k of keys) out[k] = shapeOf(value[k], depth + 1);
      return out;
    }
    return t;
  }

  /** Query param KEYS only (values may be GSTIN/PII). */
  function queryKeys(url) {
    try {
      const u = new URL(url, location.origin);
      return [...u.searchParams.keys()];
    } catch {
      return [];
    }
  }

  function pathOf(url) {
    try {
      return new URL(url, location.origin).pathname;
    } catch {
      return url;
    }
  }

  function tryParse(text) {
    if (typeof text !== 'string' || !text) return undefined;
    try { return JSON.parse(text); } catch { return undefined; }
  }

  function record(method, url, reqBody, respText, status) {
    if (!isInteresting(url)) return;
    const key = `${method} ${pathOf(url)}`;
    const existing = records.get(key) || {
      method,
      path: pathOf(url),
      queryKeys: queryKeys(url),
      requestShape: undefined,
      responseShape: undefined,
      statuses: new Set(),
      count: 0,
      seenOnPage: new Set(),
    };
    existing.count += 1;
    if (status != null) existing.statuses.add(status);
    existing.seenOnPage.add(location.pathname + location.hash);
    for (const k of queryKeys(url)) if (!existing.queryKeys.includes(k)) existing.queryKeys.push(k);

    const reqJson = tryParse(reqBody);
    if (reqJson !== undefined && existing.requestShape === undefined) {
      existing.requestShape = shapeOf(reqJson);
    }
    const respJson = tryParse(respText);
    if (respJson !== undefined && existing.responseShape === undefined) {
      existing.responseShape = shapeOf(respJson);
    }
    records.set(key, existing);
  }

  // --- wrap fetch -----------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    const reqBody = init && typeof init.body === 'string' ? init.body : undefined;
    const resp = await origFetch.apply(this, args);
    if (isInteresting(url)) {
      try {
        const clone = resp.clone();
        const text = await clone.text();
        record(method.toUpperCase(), url, reqBody, text, resp.status);
      } catch { /* opaque/streamed response — record without body */ record(method.toUpperCase(), url, reqBody, undefined, resp.status); }
    }
    return resp;
  };

  // --- wrap XMLHttpRequest ---------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__cap = { method: (method || 'GET').toUpperCase(), url };
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const cap = this.__cap;
    if (cap && isInteresting(cap.url)) {
      this.addEventListener('load', () => {
        let text;
        try { text = this.responseType === '' || this.responseType === 'text' ? this.responseText : undefined; } catch { /* ignore */ }
        record(cap.method, cap.url, typeof body === 'string' ? body : undefined, text, this.status);
      });
    }
    return origSend.call(this, body);
  };

  function toPlain() {
    return [...records.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((r) => ({
        method: r.method,
        path: r.path,
        queryKeys: r.queryKeys,
        statuses: [...r.statuses],
        callCount: r.count,
        seenOnPages: [...r.seenOnPage],
        requestShape: r.requestShape ?? null,
        responseShape: r.responseShape ?? null,
      }));
  }

  window.__gstCapture = {
    dump() {
      const plain = toPlain();
      console.log(`[capture] ${plain.length} distinct endpoint(s) recorded:`);
      console.table(plain.map((p) => ({
        method: p.method,
        path: p.path,
        query: p.queryKeys.join(','),
        status: p.statuses.join(','),
        calls: p.callCount,
      })));
      console.log('Run __gstCapture.copy() to copy the full JSON (shapes included) to your clipboard.');
      return plain;
    },
    json() {
      return JSON.stringify(toPlain(), null, 2);
    },
    copy() {
      const json = this.json();
      // `copy` is a DevTools console helper; fall back to clipboard API.
      if (typeof copy === 'function') { copy(json); console.log('[capture] copied to clipboard'); }
      else navigator.clipboard?.writeText(json).then(() => console.log('[capture] copied to clipboard'));
      return undefined;
    },
    clear() { records.clear(); console.log('[capture] cleared'); },
    stop() {
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend;
      delete window.__gstCapture;
      console.log('[capture] disarmed — originals restored');
    },
  };

  console.log('%c[capture] armed', 'color:#0a0;font-weight:bold', '— browse the notices pages, then run __gstCapture.dump()');
})();
