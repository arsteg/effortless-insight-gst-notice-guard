# Portal Endpoint Capture — Runbook

Goal: discover the GST portal's internal JSON endpoints (the XHR/fetch calls
behind the notices screens) and their request/response **shapes**, so the
content script can call them directly instead of scraping the DOM.

You need to do this yourself because it requires a live, logged-in portal
session (your credentials + captcha). The capture tool records field *names and
types only* — no GSTINs, amounts, or notice contents — so the output is safe to
paste back here.

---

## What you'll need

- Chrome, logged into <https://services.gst.gov.in> as normal.
- `tools/portal-capture.js` (in this repo).
- ~5 minutes.

---

## Steps

1. **Log in** to the GST portal and land on the dashboard.

2. **Open DevTools** (`F12` or `Ctrl+Shift+I`) and go to the **Console** tab.

3. **Arm the capture.** Open `tools/portal-capture.js`, copy the whole file, and
   paste it into the Console, then Enter.
   - If Chrome shows a *"Warning: Don't paste code you don't understand"*
     self-XSS prompt, type `allow pasting` and Enter, then paste again.
   - You should see a green **`[capture] armed`** message.

4. **Browse the notices screens** so the portal fires its data calls. Hit each
   of these (the tool dedupes, so revisiting is fine):
   - **Services → User Services → View Notices and Orders** — let the table
     load; click **next page** once; open **one notice's detail/view**.
   - **Services → User Services → View Additional Notices/Orders** — open a
     case, then open a notice inside it (this is the DRC/ASMT/case flow).
   - If you use them: the **Refund** and **Registration** notice screens.
   - Where a notice has a **Download** link for the PDF, click it once (captures
     the PDF endpoint too).

5. **Dump the results.** Back in the Console:
   ```js
   __gstCapture.dump()   // prints a table of every endpoint recorded
   __gstCapture.copy()   // copies the full JSON (with shapes) to your clipboard
   ```

6. **Save it.** Paste the clipboard JSON into a file (e.g.
   `tools/captured-endpoints.json` in this repo) or straight back into this chat.

7. **Disarm** when done: `__gstCapture.stop()`.

---

## Cross-check (optional but useful)

While browsing, keep the DevTools **Network** tab open with the **Fetch/XHR**
filter on. That gives you the ground truth to compare against — you should see
the same request URLs the tool records. If a screen loads a table but the tool
recorded nothing for it, that page may render server-side (no XHR) — note which
screen so we handle it as a DOM-scrape fallback.

---

## What I do with the output

From the captured JSON I can, for each notices screen:

- Identify the exact endpoint path + method + query/body parameters the content
  script should call (with `credentials: 'include'`, same as the existing PDF
  download in `src/sync/sync-manager.js`).
- Map the response `responseShape` fields onto our `SyncNoticeData` DTO
  (`portalNoticeId`, `noticeType`, `issueDate`, `dueDate`, `demandAmount`, …).
- Rewrite `content.js` to fetch structured JSON directly, keeping the current
  CSS-selector scraping as a fallback for any screen with no JSON endpoint.

---

## Notes / gotchas

- **Session tokens:** many portal endpoints require an anti-CSRF/session token
  sent as a header or in the body. The tool records request *shapes*, so if you
  see a `requestShape` with a field like `token`/`csrf`/`__RequestVerificationToken`,
  flag it — the content script will need to read that value from the page or a
  cookie before calling the endpoint.
- **The tool only observes** — it makes no network calls of its own and never
  contacts the extension backend. Refreshing the page clears it; just re-arm.
- **Nothing is auto-sent.** You choose what to share. The recorded shapes are
  structural only, but always glance at the JSON before pasting it anywhere.
