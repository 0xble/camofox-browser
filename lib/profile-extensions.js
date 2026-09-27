import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Firefox installs any signed <id>.xpi found in <profile>/extensions at
// startup and uninstalls it when the file disappears. This module owns only
// the files it records in MANAGED_FILE, so extensions a human installs through
// about:addons are never touched.
const MANAGED_FILE = 'camofox-managed-extensions.json';
const EXTENSION_ID = /^(?:\{[0-9a-fA-F-]{36}\}|[A-Za-z0-9._+-]+@[A-Za-z0-9._-]+)$/;
const SHA256 = /^[0-9a-f]{64}$/;

function validSpec(spec) {
  return spec && typeof spec === 'object'
    && typeof spec.id === 'string' && EXTENSION_ID.test(spec.id)
    && typeof spec.path === 'string' && path.isAbsolute(spec.path)
    && typeof spec.sha256 === 'string' && SHA256.test(spec.sha256);
}

/**
 * Parse CAMOFOX_SHARED_IDENTITY_EXTENSIONS.
 *
 * Shape: {"<alias or userId>": [{"id": "...", "path": "/abs/x.xpi", "sha256": "<hex>"}]}.
 * Aliases resolve through the shared identity alias map so the result is keyed
 * by the exact server-visible userId.
 *
 * Invalid input must never become an uninstall request. The result is:
 * - `{}` when unset or empty: no identity has managed extensions.
 * - `null` when the whole value is malformed: every profile is left untouched.
 * - otherwise a map whose value is the validated list, or `null` for an
 *   identity whose list is invalid (that profile is left untouched).
 */
export function parseSharedIdentityExtensions(value, aliases = {}, logger) {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    logger?.('error', 'CAMOFOX_SHARED_IDENTITY_EXTENSIONS is not valid JSON; profile extensions left unchanged');
    return null;
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    logger?.('error', 'CAMOFOX_SHARED_IDENTITY_EXTENSIONS must be an object; profile extensions left unchanged');
    return null;
  }
  const result = {};
  const seen = new Set();
  for (const [identity, specs] of Object.entries(parsed)) {
    const userId = aliases[identity] || identity;
    if (seen.has(userId)) {
      // An alias and its userId (or two aliases) name the same profile. Which
      // list wins would depend on key order, so treat the identity as invalid.
      logger?.('error', 'shared identity configured more than once; its profile extensions are left unchanged', { identity });
      result[userId] = null;
      continue;
    }
    seen.add(userId);
    const ids = Array.isArray(specs) ? specs.map(spec => spec?.id) : [];
    if (!Array.isArray(specs) || !specs.every(validSpec) || new Set(ids).size !== ids.length) {
      logger?.('error', 'invalid extension list for shared identity; its profile extensions are left unchanged', { identity });
      result[userId] = null;
      continue;
    }
    result[userId] = specs.map(({ id, path: file, sha256 }) => ({ id, path: file, sha256 }));
  }
  return result;
}

/**
 * Resolve the extension list for one identity from the parsed configuration.
 * Returns `null` when configuration is invalid, meaning "do not touch the profile".
 */
export function extensionsForIdentity(parsed, userId) {
  if (parsed === null) return null;
  if (!parsed || !Object.hasOwn(parsed, userId)) return [];
  return parsed[userId];
}

async function readVerified(file) {
  const bytes = await fs.readFile(file);
  return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

async function sha256File(file) {
  return (await readVerified(file)).sha256;
}

async function readManaged(profilePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(profilePath, MANAGED_FILE), 'utf8'));
    return Array.isArray(parsed?.ids) ? parsed.ids.filter(id => typeof id === 'string' && EXTENSION_ID.test(id)) : [];
  } catch {
    return [];
  }
}

/**
 * Make <profile>/extensions match the configured list before Firefox starts.
 *
 * - A source artifact whose SHA-256 differs from the pin is never installed.
 *   Any previously installed copy of that extension is left as is.
 * - The bytes written are the exact bytes that were verified.
 * - Unchanged installed copies are not rewritten.
 * - An extension file that exists but was not installed by this module is
 *   human-owned. It is never overwritten, adopted, or later removed.
 * - Extensions this module installed earlier but no longer configured are removed.
 */
export async function syncProfileExtensions(profilePath, specs = [], logger) {
  const extensionsDir = path.join(profilePath, 'extensions');
  const previous = await readManaged(profilePath);
  const summary = { installed: [], unchanged: [], removed: [], rejected: [], skipped: [] };
  if (!specs.length && !previous.length) return summary;

  await fs.mkdir(extensionsDir, { recursive: true, mode: 0o700 });
  const managed = [];
  for (const spec of specs) {
    const target = path.join(extensionsDir, `${spec.id}.xpi`);
    const owned = previous.includes(spec.id);
    const exists = await fs.lstat(target).then(() => true, () => false);
    if (exists && !owned) {
      summary.skipped.push(spec.id);
      logger?.('warn', 'extension already installed outside Camofox management; left untouched', { id: spec.id });
      continue;
    }
    let source;
    try {
      source = await readVerified(spec.path);
    } catch (error) {
      summary.rejected.push(spec.id);
      logger?.('error', 'pinned extension artifact unreadable; not installed', { id: spec.id, error: error.code || error.message });
      if (owned) managed.push(spec.id);
      continue;
    }
    if (source.sha256 !== spec.sha256) {
      summary.rejected.push(spec.id);
      logger?.('error', 'pinned extension checksum mismatch; not installed', { id: spec.id });
      if (owned) managed.push(spec.id);
      continue;
    }
    managed.push(spec.id);
    const installedHash = exists ? await sha256File(target).catch(() => null) : null;
    if (installedHash === spec.sha256) {
      summary.unchanged.push(spec.id);
      continue;
    }
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporary, source.bytes, { mode: 0o600 });
    await fs.rename(temporary, target);
    summary.installed.push(spec.id);
  }

  for (const id of previous) {
    if (managed.includes(id)) continue;
    await fs.rm(path.join(extensionsDir, `${id}.xpi`), { force: true });
    summary.removed.push(id);
  }

  const record = path.join(profilePath, MANAGED_FILE);
  const temporary = `${record}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, JSON.stringify({ version: 1, ids: managed }), { mode: 0o600 });
  await fs.rename(temporary, record);
  if (summary.installed.length || summary.removed.length || summary.rejected.length) {
    logger?.('info', 'shared identity extensions synchronized', summary);
  }
  return summary;
}

export const MANAGED_EXTENSIONS_FILE = MANAGED_FILE;
