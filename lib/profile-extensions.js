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
 * by the exact server-visible userId. Invalid input fails closed to no
 * extensions for the affected identity rather than guessing.
 */
export function parseSharedIdentityExtensions(value, aliases = {}, logger) {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    logger?.('error', 'CAMOFOX_SHARED_IDENTITY_EXTENSIONS is not valid JSON; no extensions will be managed');
    return {};
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    logger?.('error', 'CAMOFOX_SHARED_IDENTITY_EXTENSIONS must be an object; no extensions will be managed');
    return {};
  }
  const result = {};
  for (const [identity, specs] of Object.entries(parsed)) {
    const userId = aliases[identity] || identity;
    const ids = Array.isArray(specs) ? specs.map(spec => spec?.id) : [];
    if (!Array.isArray(specs) || !specs.every(validSpec) || new Set(ids).size !== ids.length) {
      logger?.('error', 'invalid extension list for shared identity; none will be managed', { identity });
      continue;
    }
    result[userId] = specs.map(({ id, path: file, sha256 }) => ({ id, path: file, sha256 }));
  }
  return result;
}

async function sha256File(file) {
  const bytes = await fs.readFile(file);
  return crypto.createHash('sha256').update(bytes).digest('hex');
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
 * - Unchanged installed copies are not rewritten.
 * - Extensions this module installed earlier but no longer configured are removed.
 */
export async function syncProfileExtensions(profilePath, specs = [], logger) {
  const extensionsDir = path.join(profilePath, 'extensions');
  const previous = await readManaged(profilePath);
  const summary = { installed: [], unchanged: [], removed: [], rejected: [] };
  if (!specs.length && !previous.length) return summary;

  await fs.mkdir(extensionsDir, { recursive: true, mode: 0o700 });
  const managed = [];
  for (const spec of specs) {
    const target = path.join(extensionsDir, `${spec.id}.xpi`);
    let sourceHash;
    try {
      sourceHash = await sha256File(spec.path);
    } catch (error) {
      summary.rejected.push(spec.id);
      logger?.('error', 'pinned extension artifact unreadable; not installed', { id: spec.id, error: error.code || error.message });
      if (previous.includes(spec.id)) managed.push(spec.id);
      continue;
    }
    if (sourceHash !== spec.sha256) {
      summary.rejected.push(spec.id);
      logger?.('error', 'pinned extension checksum mismatch; not installed', { id: spec.id });
      if (previous.includes(spec.id)) managed.push(spec.id);
      continue;
    }
    managed.push(spec.id);
    const installedHash = await sha256File(target).catch(() => null);
    if (installedHash === spec.sha256) {
      summary.unchanged.push(spec.id);
      continue;
    }
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.copyFile(spec.path, temporary);
    await fs.chmod(temporary, 0o600);
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
