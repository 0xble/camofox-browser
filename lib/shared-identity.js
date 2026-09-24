import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const PROFILE_LOCK_RETRY_MS = 45_000;
const PROFILE_LOCK_INITIAL_BACKOFF_MS = 100;
const PROFILE_LOCK_MAX_BACKOFF_MS = 2_000;

function isProfileLockError(error) {
  const message = String(error?.message || '');
  return /(?:profile[^\n]*(?:in use|locked|lock file|already running)|firefox is already running|singletonlock)/i.test(message);
}

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
    this.closings = new Set();
    // A rejected close cannot prove the profile lock was released.
    this.failedClosures = new Set();
    this.confirmedClosed = new WeakSet();
    // Only a confirmed close permits short-lived profile-lock relaunch retries.
    this.closedAt = new Map();
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
    if (this.failedClosures.has(key)) throw new Error('shared identity close failed; profile ownership is unconfirmed');
    if (this.closings.has(key)) throw new Error('shared identity close in progress; profile ownership is unconfirmed');
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
        const closedAt = this.closedAt.get(key);
        const deadline = closedAt === undefined ? 0 : closedAt + PROFILE_LOCK_RETRY_MS;
        let backoff = PROFILE_LOCK_INITIAL_BACKOFF_MS;
        while (true) {
          try {
            context = await createContext(this.profileFor(key));
            break;
          } catch (error) {
            const remaining = deadline - Date.now();
            if (!isProfileLockError(error) || remaining <= 0 || this.failedClosures.has(key)) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(backoff, remaining)));
            if (Date.now() >= deadline) throw error;
            backoff = Math.min(backoff * 2, PROFILE_LOCK_MAX_BACKOFF_MS);
          }
        }
        this.closedAt.delete(key);
        // Persistent launch receives no storage state and no page is created
        // until this scoped recovery has completed.
        if (recoveryCookies.length) await context.addCookies(recoveryCookies);
        const forgetClosedContext = () => {
          this.confirmedClosed.add(context);
          if (this.contexts.get(key) === context) {
            this.failedClosures.delete(key);
            this.contexts.delete(key);
            this.closedAt.set(key, Date.now());
          }
        };
        context.on?.('close', forgetClosedContext);
        this.contexts.set(key, context);
        return context;
      } catch (error) {
        if (context) {
          try { await context.close(); }
          catch {
            // A returned context may still own the profile after recovery fails.
            this.failedClosures.add(key);
          }
        }
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

  // Read the checkpoint cookies before any teardown so a failed read can abort a
  // headed transition while the live session is still fully intact.
  async snapshotCookies(identity) {
    const context = this.contexts.get(String(identity));
    if (!context) return undefined;
    return context.cookies();
  }

  async close(identity, { checkpoint = true, reason = 'session_closed', cookies: snapshot } = {}) {
    const key = String(identity);
    const context = this.contexts.get(key);
    if (!context) return false;
    this.closings.add(key);
    try {
      let cookies = snapshot;
      // A storage reset must not replay session credentials. If reading cookies
      // fails during handoff, leave the live context in place and abort.
      if (checkpoint && !cookies) {
        try { cookies = await context.cookies(); }
        catch (error) {
          if (reason === 'headed_transition') throw error;
          checkpoint = false;
          this.logger?.warn?.('shared identity cookie snapshot failed; closing without checkpoint', { identity: key, error: error.message });
        }
      }
      try { await context.close(); }
      catch (error) {
        // A close event is stronger evidence than a rejected close promise.
        if (!this.confirmedClosed.has(context)) this.failedClosures.add(key);
        throw error;
      }
      this.failedClosures.delete(key);
      if (this.contexts.get(key) === context) this.contexts.delete(key);
      this.closedAt.set(key, Date.now());
      // A failed checkpoint write leaves the pre-launch dirty marker intact,
      // but does not imply that the profile lock is still held.
      if (checkpoint) await writeCheckpoint(this.profileDir, key, { cleanShutdown: true, cookies });
      return true;
    } finally {
      this.closings.delete(key);
    }
  }
}

export { cookieCheckpointPath, identityDirectory, safeCookies, sessionCookies };
