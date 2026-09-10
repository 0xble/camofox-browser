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
    return cookie.expires === undefined || cookie.expires === -1 || cookie.expires > nowSeconds;
  }).map(cookie => {
    const kept = {};
    for (const key of ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'partitionKey']) {
      if (cookie[key] !== undefined) kept[key] = cookie[key];
    }
    return kept;
  });
}

function sessionCookies(cookies) {
  return safeCookies(cookies).filter(cookie => cookie.expires === undefined || cookie.expires === -1);
}

async function readCheckpoint(rootDir, identity, logger) {
  try {
    const raw = await fs.readFile(cookieCheckpointPath(rootDir, identity), 'utf8');
    const parsed = JSON.parse(raw);
    // A snapshot is usable only after a prior clean close. Legacy and dirty
    // snapshots intentionally fail closed: Firefox itself still owns durable
    // profile cookies, but stale session credentials must never be resurrected.
    return parsed?.version === 2 && parsed?.cleanShutdown === true ? sessionCookies(parsed.cookies) : [];
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.('shared identity cookie checkpoint unreadable', { identity, error: error.message });
    return [];
  }
}

async function writeCheckpoint(rootDir, identity, { cleanShutdown, cookies = [] }) {
  const dir = identityDirectory(rootDir, identity);
  const target = cookieCheckpointPath(rootDir, identity);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await fs.writeFile(temporary, JSON.stringify({
    version: 2,
    cleanShutdown: Boolean(cleanShutdown),
    // Persistent cookies stay in Firefox's profile. Only Playwright session
    // cookies need recovery, and they are valid only after a clean close.
    cookies: sessionCookies(cookies),
  }), { mode: 0o600 });
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
      // Invalidate any previous clean-close checkpoint before launch. A process
      // crash or an externally closed context can therefore never replay it.
      const recoveryCookies = await readCheckpoint(this.profileDir, key, this.logger);
      await writeCheckpoint(this.profileDir, key, { cleanShutdown: false });
      let context;
      try {
        context = await createContext(this.profileFor(key));
        // Persistent launch receives no storage state and no page is created
        // until this scoped recovery has completed.
        if (recoveryCookies.length) await context.addCookies(recoveryCookies);
        const forgetClosedContext = () => {
          if (this.contexts.get(key) === context) this.contexts.delete(key);
        };
        context.on?.('close', forgetClosedContext);
        this.contexts.set(key, context);
        return context;
      } catch (error) {
        await context?.close?.().catch(() => {});
        throw error;
      } finally {
        this.opens.delete(key);
      }
    })();
    this.opens.set(key, promise);
    return promise;
  }

  async focus(identity) {
    const context = this.contexts.get(String(identity));
    if (!context) return null;
    let page = context.pages().find(candidate => !candidate.isClosed());
    if (!page) page = await context.newPage();
    await page.bringToFront();
    return page;
  }

  async close(identity) {
    const key = String(identity);
    const context = this.contexts.get(key);
    if (!context) return false;
    let cookies;
    try {
      cookies = await context.cookies();
      await context.close?.();
      // A checkpoint becomes eligible only after the profile-owning context
      // closed successfully. If either step fails, the dirty marker remains.
      await writeCheckpoint(this.profileDir, key, { cleanShutdown: true, cookies });
      return true;
    } finally {
      if (this.contexts.get(key) === context) this.contexts.delete(key);
    }
  }
}

export { cookieCheckpointPath, identityDirectory, safeCookies, sessionCookies };
