/**
 * GST Notice Guard - Release Build
 *
 * Produces a Chrome Web Store-ready package with all localhost/dev support
 * removed:
 *   - manifest.json: drops any host_permissions / content_scripts matches
 *     that reference localhost
 *   - src/config.js: strips the BUILD:DEV-ONLY-START..END block (the local
 *     API environment), so only the live environment ships
 *   - excludes tools/ and other non-runtime files
 *
 * Output: dist/release/ (unpacked) and dist/gst-notice-guard-v<version>.zip
 *
 * Usage: node tools/build-release.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'release');

const EXCLUDE_TOP_LEVEL = new Set(['tools', 'dist', 'node_modules', '.git']);
const EXCLUDE_FILES = new Set(['README.md']);

// Dotfiles (.gitignore, .env*, editor config) are never runtime files.
function isExcluded(name) {
  return EXCLUDE_FILES.has(name) || name.startsWith('.');
}

function isLocalhost(url) {
  return /localhost|127\.0\.0\.1/i.test(url);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (isExcluded(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Clean output and copy runtime files
// ---------------------------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (EXCLUDE_TOP_LEVEL.has(entry.name) || isExcluded(entry.name)) continue;
  const from = path.join(ROOT, entry.name);
  const to = path.join(OUT, entry.name);
  if (entry.isDirectory()) {
    copyDir(from, to);
  } else {
    fs.copyFileSync(from, to);
  }
}

// ---------------------------------------------------------------------------
// 2. Strip localhost from manifest.json
// ---------------------------------------------------------------------------
const manifestPath = path.join(OUT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

manifest.host_permissions = (manifest.host_permissions || []).filter(p => !isLocalhost(p));

manifest.content_scripts = (manifest.content_scripts || [])
  .map(cs => ({ ...cs, matches: (cs.matches || []).filter(m => !isLocalhost(m)) }))
  .filter(cs => cs.matches.length > 0);

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// ---------------------------------------------------------------------------
// 3. Strip the dev-only environment block from src/config.js
// ---------------------------------------------------------------------------
const configPath = path.join(OUT, 'src', 'config.js');
let config = fs.readFileSync(configPath, 'utf8');

const stripped = config.replace(
  /[ \t]*\/\/ BUILD:DEV-ONLY-START[\s\S]*?\/\/ BUILD:DEV-ONLY-END[ \t]*\r?\n/,
  ''
);

if (stripped === config) {
  throw new Error('BUILD:DEV-ONLY markers not found in src/config.js — refusing to ship a build that may contain localhost support.');
}
if (isLocalhost(stripped)) {
  throw new Error('localhost still referenced in release config.js after stripping — aborting.');
}
fs.writeFileSync(configPath, stripped);

// ---------------------------------------------------------------------------
// 4. Safety sweep: no localhost anywhere in the release output
// ---------------------------------------------------------------------------
function sweep(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sweep(p);
    } else if (/\.(js|json|html|css)$/.test(entry.name)) {
      if (isLocalhost(fs.readFileSync(p, 'utf8'))) {
        throw new Error(`localhost reference found in release file: ${path.relative(OUT, p)}`);
      }
    }
  }
}
sweep(OUT);

// ---------------------------------------------------------------------------
// 5. Zip for the Chrome Web Store
// ---------------------------------------------------------------------------
const zipPath = path.join(DIST, `gst-notice-guard-v${manifest.version}.zip`);
fs.rmSync(zipPath, { force: true });
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zipPath}'"`,
  { stdio: 'inherit' }
);

console.log('');
console.log(`Release build complete (v${manifest.version})`);
console.log(`  Unpacked: ${OUT}`);
console.log(`  Store upload: ${zipPath}`);
