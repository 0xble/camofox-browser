import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function identityDirectory(rootDir, identity) {
  const digest = crypto.createHash('sha256').update(String(identity)).digest('hex').slice(0, 32);
  return path.join(path.resolve(rootDir), digest);
}

function cookieCheckpointPath(rootDir, identity) {
  return path.join(identityDirectory(rootDir, identity), 'session-cookies.json');
}

function safeCookies(cookies, nowSeconds = Date.now() / 1000) {
  return (Array.isArray(cookies) ? cookies : []).filter(cookie => {
    if (!cookie || typeof cookie !== 'object') return false;
    // Playwright uses -1 for session cookies. Keep it; those are the recovery
    // case this checkpoint exists for. Omit only explicitly expired cookies.
    return cookie.expires === undefined || cookie.expires === -1 || cookie.expires > nowSeconds;
  }).map(cookie => {
    const kept = {};
    for (const key of ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'partitionKey']) {
      if (cookie[key] !== undefined) kept[key] = cookie[key];
    }
    return kept;
  });
}

async function readCookies(rootDir, identity, logger) {
  try {
    const raw = await fs.readFile(cookieCheckpointPath(rootDir, identity), 'utf8');
    const parsed = JSON.parse(raw);
    return safeCookies(parsed?.cookies);
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.('shared identity cookie checkpoint unreadable', { identity, error: error.message });
    return [];
  }
}

async function writeCookies(rootDir, identity, cookies) {
  const dir = identityDirectory(rootDir, identity);
  const target = cookieCheckpointPath(rootDir, identity);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  // Replace, including with an empty array: an explicit logout must not revive
  // an earlier authenticated checkpoint after a restart.
  await fs.writeFile(temporary, JSON.stringify({ version: 1, cookies: safeCookies(cookies) }), { mode: 0o600 });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

export class SharedIdentityManager {
  constructor({ identities = [], profileDir, logger = console }) {
    this.identities = new Set(identities.map(String));
    this.profileDir = profileDir;
    this.logger = logger;
    this.contexts = new Map();
    this.opens = new Map();
  }

  owns(identity) {
    return this.identities.has(String(identity));
  }

  profileFor(identity) {
    if (!this.owns(identity)) throw new Error('shared identity is not allowlisted');
    return identityDirectory(this.profileDir, identity);
  }

  async open(identity, createContext) {
    const key = String(identity);
    if (!this.owns(key)) throw new Error('shared identity is not allowlisted');
    const active = this.contexts.get(key);
    if (active) return active;
    const opening = this.opens.get(key);
    if (opening) return opening;
    const promise = (async () => {
      const context = await createContext(this.profileFor(key));
      try {
        const cookies = await readCookies(this.profileDir, key, this.logger);
        // Explicitly restore cookies after the persistent context is created and
        // before any page is opened. Do not pass storageState to persistent launch.
        if (cookies.length) await context.addCookies(cookies);
        this.contexts.set(key, context);
        return context;
      } catch (error) {
        await context.close?.().catch(() => {});
        throw error;
      } finally {
        this.opens.delete(key);
      }
    })();
    this.opens.set(key, promise);
    return promise;
  }

  async checkpoint(identity) {
    const key = String(identity);
    const context = this.contexts.get(key);
    if (!context) return false;
    await writeCookies(this.profileDir, key, await context.cookies());
    return true;
  }

  async focus(identity) {
    const context = this.contexts.get(String(identity));
    const page = context?.pages?.().find(page => !page.isClosed?.());
    if (!page) return false;
    await page.bringToFront?.();
    return true;
  }

  async close(identity, { checkpoint = true } = {}) {
    const key = String(identity);
    const context = this.contexts.get(key);
    if (!context) return false;
    if (checkpoint) await this.checkpoint(key);
    this.contexts.delete(key);
    await context.close();
    return true;
  }
}

export { cookieCheckpointPath, identityDirectory, safeCookies };
