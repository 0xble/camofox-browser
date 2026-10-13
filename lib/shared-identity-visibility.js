import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { windowBounds } from './park-display-launcher.js';

const PAGE_PREFIX = 'about:blank#camofox-';

export function visibilityAddonFiles({ endpoint, park, main }) {
  return {
    'manifest.json': JSON.stringify({ manifest_version: 2, name: 'Camofox window parking', version: '1.0',
      browser_specific_settings: { gecko: { id: 'camofox-window-parking@camofox.local' } },
      permissions: ['tabs', 'http://127.0.0.1/*'], background: { scripts: ['background.js'] } }),
    'background.js': `const endpoint=${JSON.stringify(endpoint)};
const park=${JSON.stringify(park)},main=${JSON.stringify(main)};
const done=new Set(),queues=new Map();let polling=false;
async function ack(value){return (await fetch(endpoint,{method:'POST',body:JSON.stringify(value)})).json()}
async function target(c){
  if(c.marker){const tabs=await browser.tabs.query({title:c.marker});if(tabs.length!==1)return null;return {windowId:tabs[0].windowId,tabId:tabs[0].id};}
  if(c.tabId!=null){const t=await browser.tabs.get(c.tabId).catch(()=>null);if(t)return {windowId:t.windowId,tabId:t.id};
    // A human can close the handed-off tab and keep its window open. Parking
    // still applies to that window; a window that is gone needs no parking.
    if(c.windowId==null||!['park','dispose'].includes(c.action))throw new Error('tab ended');}
  if(c.windowId!=null&&['park','dispose'].includes(c.action)){
    const w=await browser.windows.get(c.windowId,{populate:true}).catch(()=>null);
    if(!w)return {windowId:c.windowId,tabId:null,gone:true};
    const live=(w.tabs||[]).find(t=>t.active)||(w.tabs||[])[0];
    return {windowId:w.id,tabId:live?live.id:null};
  }
  return {windowId:c.windowId,tabId:c.tabId};
}
async function perform(c){
  let windowId=c.windowId,tabId=c.tabId,created=false,shown=false,wasVisible=false;
  async function undo(){
    if(created)await browser.windows.remove(windowId);
    else if(shown&&!wasVisible){await browser.windows.update(windowId,park);await ack({parked:windowId});}
  }
  try{
    if(c.action==='create'){
      // Camoufox may restart the background page while creating a window. Its
      // controlled URL is a durable command disambiguator across that restart.
      const existing=(await browser.tabs.query({})).find(t=>t.url===c.url);
      if(Date.now()>=c.expiresAt){if(existing)await browser.windows.remove(existing.windowId);await ack({id:c.id,error:'expired'});return;}
      if(existing){windowId=existing.windowId;tabId=existing.id;created=true;}
      else{const w=await browser.windows.create({...park,url:c.url});windowId=w.id;tabId=w.tabs[0].id;created=true;}
    }else{
      const t=await target(c);if(!t)return;windowId=t.windowId;tabId=t.tabId;
      // Read rollback ownership inside the window queue, after prior acknowledgments.
      // An issue-time snapshot can predate a concurrent successful handoff.
      if(c.action==='show')wasVisible=(await(await fetch(endpoint)).json()).visible.includes(windowId);
      if(Date.now()>=c.expiresAt){if(c.action==='show'&&!wasVisible){await browser.windows.update(windowId,park);await ack({parked:windowId});}await ack({id:c.id,error:'expired'});return;}
      if(t.gone){await ack({id:c.id,windowId,tabId:null,gone:true});return;}
      if(c.action==='show'){if(tabId!=null)await browser.tabs.update(tabId,{active:true});shown=true;await browser.windows.update(windowId,main);}
      else if(c.action==='park')await browser.windows.update(windowId,park);
      else if(c.action==='dispose')await browser.windows.remove(windowId);
    }
    const result=await ack({id:c.id,windowId,tabId});
    if(!result.accepted)await undo();
  }catch(e){await undo().catch(()=>{});await ack({id:c.id,error:String(e)}).catch(()=>{});}
}
async function dispatch(c){
  if(done.has(c.id))return;
  let t;
  try{t=c.action==='create'?{windowId:c.id}:await target(c);}catch(e){done.add(c.id);await ack({id:c.id,error:String(e)});return;}
  if(!t)return; // A short locate retry can re-apply an SPA's title marker.
  done.add(c.id);
  const key=t.windowId;
  const next=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(()=>perform(c.marker?{...c,marker:null,...t}:c));
  queues.set(key,next);
  next.finally(()=>{if(queues.get(key)===next)queues.delete(key)}).catch(()=>{});
}
browser.windows.onRemoved.addListener(windowId=>ack({removed:windowId}).catch(()=>{}));
browser.tabs.onRemoved.addListener(async(tabId,info)=>{if(!info||info.isWindowClosing)return;
  try{const [live]=await browser.tabs.query({windowId:info.windowId,active:true});await ack({tabRemoved:tabId,windowId:info.windowId,tabId:live?live.id:null});}catch{}});
async function classifyWindow(w,snapshot){
  const tabs=w.tabs||await browser.tabs.query({windowId:w.id});
  if(snapshot.visible.includes(w.id))return;
  const api=tabs.some(t=>(t.url||t.pendingUrl||'').startsWith('${PAGE_PREFIX}'));
  if(api||snapshot.parked.includes(w.id))return;
  const opener=tabs.find(t=>t.openerTabId!=null);
  const source=opener?await browser.tabs.get(opener.openerTabId).catch(()=>null):null;
  // Popups follow their opener's window; only opener-less UI windows (a human
  // pressing New Window during a handoff) follow the global handoff state.
  if(opener?Boolean(source&&snapshot.visible.includes(source.windowId)):snapshot.visible.length){
    // New UI windows can inherit parked profile geometry, even when the opener
    // is shown. Move them to the human's display, never the API parking lane.
    await browser.windows.update(w.id,main);
    await ack({inherited:w.id,tabId:tabs[0]&&tabs[0].id});
  }else{await browser.windows.update(w.id,park);await ack({parked:w.id});}
}
browser.windows.onCreated.addListener(async w=>{try{await classifyWindow(w,await(await fetch(endpoint)).json());}catch{}});
(async()=>{const snapshot=await(await fetch(endpoint)).json();for(const w of await browser.windows.getAll())await classifyWindow(w,snapshot);await ack({ready:true});
setInterval(async()=>{if(polling)return;polling=true;try{const {commands}=await(await fetch(endpoint)).json();const active=new Set(commands.map(c=>c.id));for(const id of done)if(!active.has(id))done.delete(id);for(const c of commands)await dispatch(c);}catch{}finally{polling=false}},50)})();\n`,
  };
}

export async function prepareParkedProfile(profilePath, display) {
  const file = path.join(profilePath, 'xulstore.json');
  let data;
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  const key = 'chrome://browser/content/browser.xhtml';
  if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) data[key] = {};
  const existing = data[key]['main-window'];
  data[key]['main-window'] = { ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
    screenX: String(display.left), screenY: String(display.top),
    width: String(display.width), height: String(display.height), sizemode: 'normal' };
  const staging = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(staging, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(staging, file);
}

// Only dead-owner directories are removed; other isolated servers may be live.
export async function cleanupVisibilityAddons(rootDir, { now = Date.now() } = {}) {
  for (const entry of await fs.readdir(rootDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const dir = path.join(rootDir, entry.name);
    let dead = false;
    try {
      const { pid } = JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
    } catch {
      // Pre-owner-marker add-ons are only safe to reap after a long grace period.
      dead = now - (await fs.stat(dir)).mtimeMs > 86400000;
    }
    if (dead) await fs.rm(dir, { recursive: true, force: true });
  }
}

async function snapshotProfileForFallback(profilePath) {
  const file = path.join(profilePath, 'xulstore.json');
  try {
    const [contents, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
    const data = JSON.parse(contents);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { file, kind: 'reset' };
    return { file, kind: 'restore', contents, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return { file, kind: 'absent' };
    // A malformed xulstore is already handled as empty by prepareParkedProfile.
    // Keep the fallback launch on a valid, geometry-free store instead of
    // restoring the malformed bytes or the temporary parked geometry.
    if (error instanceof SyntaxError) return { file, kind: 'reset' };
    throw error;
  }
}

async function restoreProfileAfterFallback(snapshot) {
  if (!snapshot) return;
  if (snapshot.kind === 'absent') return fs.rm(snapshot.file, { force: true });
  if (snapshot.kind === 'reset') return fs.writeFile(snapshot.file, '{}', { mode: 0o600 });
  const staging = `${snapshot.file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(staging, snapshot.contents, { mode: snapshot.mode });
    await fs.rename(staging, snapshot.file);
  } finally {
    await fs.rm(staging, { force: true });
  }
}

export async function launchWithVisibilityFallback({ display, profilePath, headed = false, fallbackHeaded = headed, launch, log,
  createVisibility = createSharedIdentityVisibility, prepareProfile = prepareParkedProfile }) {
  let visibility, context;
  const profileSnapshot = display && profilePath ? await snapshotProfileForFallback(profilePath) : null;
  try {
    visibility = display ? await createVisibility(display) : null;
    if (visibility) await prepareProfile(profilePath, visibility.park);
    context = await launch({ headed: headed || Boolean(visibility), visibility });
    if (visibility) await visibility.attach(context);
    context.sharedIdentityVisibility = visibility;
    return context;
  } catch (error) {
    if (context) {
      let closed = false;
      context.once?.('close', () => { closed = true; });
      try { await context.close(); }
      catch { if (!closed) error.profileOwnershipUnconfirmed = true; }
    }
    await visibility?.close().catch(() => {});
    if (!display || error.profileOwnershipUnconfirmed) throw error;
    await restoreProfileAfterFallback(profileSnapshot);
    log?.('warn', 'window parking unavailable; using legacy launch for this context', { error: error.message });
    // An /open that falls back launches headed once instead of headless then headed.
    context = await launch({ headed: fallbackHeaded, visibility: null });
    context.sharedIdentityVisibility = null;
    context.sharedIdentityHeaded = fallbackHeaded;
    return context;
  }
}

export async function createSharedIdentityVisibility(display, { rootDir = path.join(os.tmpdir(), 'camofox-window-parking'), timeoutMs = 10000 } = {}) {
  await cleanupVisibilityAddons(rootDir);
  const secret = crypto.randomBytes(32).toString('hex');
  const pending = new Map(), expired = new Map(), visible = new Map(), parked = new Set(), pages = new WeakMap(), locating = new WeakMap();
  let sequence = 0;
  let readyResolve, closing;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url !== `/${secret}`) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify({ commands: [...expired.values(), ...[...pending.values()].map(entry => entry.command)].sort((a, b) => a.sequence - b.sequence), visible: [...visible.keys()], parked: [...parked] }));
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = '';
    try {
      for await (const chunk of req) { body += chunk; if (body.length > 65536) { res.writeHead(413); return res.end(); } }
      const value = JSON.parse(body);
      if (value.ready) readyResolve();
      if (value.removed != null) { visible.delete(value.removed); parked.delete(value.removed); }
      // Re-key a handoff whose tab closed inside a surviving window to the window itself.
      if (value.tabRemoved != null && visible.get(value.windowId)?.tabId === value.tabRemoved)
        visible.set(value.windowId, { windowId: value.windowId, tabId: value.tabId ?? null });
      if (value.parked != null) { visible.delete(value.parked); parked.add(value.parked); }
      if (value.inherited != null) {
        parked.delete(value.inherited); visible.set(value.inherited, { windowId: value.inherited, tabId: value.tabId });
      }
      const entry = pending.get(value.id);
      expired.delete(value.id);
      const accepted = Boolean(entry && Date.now() < entry.command.expiresAt && !value.error);
      if (entry) {
        pending.delete(value.id); clearTimeout(entry.timer);
        if (!accepted) entry.reject(new Error('window visibility operation failed'));
        else {
          const target = { windowId: value.windowId, tabId: value.tabId };
          if (entry.command.action === 'show') { parked.delete(value.windowId); visible.delete(value.windowId); visible.set(value.windowId, target); }
          if (value.gone) { visible.delete(value.windowId); parked.delete(value.windowId); }
          else if (['park', 'create'].includes(entry.command.action)) { visible.delete(value.windowId); parked.add(value.windowId); }
          if (entry.command.action === 'dispose') { visible.delete(value.windowId); parked.delete(value.windowId); }
          entry.resolve(target);
        }
      }
      res.end(JSON.stringify({ accepted }));
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  const endpoint = `http://127.0.0.1:${server.address().port}/${secret}`;
  const park = windowBounds(display.park), main = windowBounds(display.main, true);
  const addon = path.join(rootDir, crypto.randomUUID());
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('window context closed')); }
      pending.clear(); expired.clear(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await fs.rm(addon, { recursive: true, force: true });
    })();
    return closing;
  }
  try {
    await fs.mkdir(addon, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(addon, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    for (const [name, contents] of Object.entries(visibilityAddonFiles({ endpoint, park, main })))
      await fs.writeFile(path.join(addon, name), contents, { mode: 0o600 });
  } catch (error) { await close(); throw error; }
  function command(payload) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const command = { id, sequence: ++sequence, expiresAt: Date.now() + timeoutMs, ...payload };
      const timer = setTimeout(() => {
        pending.delete(id);
        if (['create', 'show'].includes(payload.action)) expired.set(id, command);
        reject(new Error('window visibility operation timed out'));
      }, timeoutMs);
      pending.set(id, { command, resolve, reject, timer });
    });
  }
  async function locate(page) {
    const known = pages.get(page);
    if (known) return { tabId: known.tabId };
    if (locating.has(page)) return locating.get(page);
    const lookup = locateUncached(page);
    locating.set(page, lookup);
    try { return await lookup; } finally { locating.delete(page); }
  }
  async function locateUncached(page) {
    const known = pages.get(page);
    if (known) return { tabId: known.tabId }; // The extension resolves the current window on every operation.
    const marker = `camofox-window-${crypto.randomUUID()}`;
    let previous, stopped = false;
    async function mark() {
      const title = await page.evaluate(value => { const old = document.title; document.title = value; return old; }, marker);
      if (title !== marker) previous = title;
    }
    await mark();
    // UI-created pages alone use a temporary title. SPAs can rewrite it between
    // the Playwright call and the extension poll, so re-apply on a short retry.
    const refresh = (async () => { while (!stopped) { await new Promise(resolve => setTimeout(resolve, 10)); if (!stopped) await mark().catch(() => {}); } })();
    try { const target = await command({ action: 'locate', marker }); pages.set(page, target); return { tabId: target.tabId }; }
    finally {
      stopped = true; await refresh;
      await page.evaluate(({ marker, previous }) => { if (document.title === marker) document.title = previous; }, { marker, previous }).catch(() => {});
    }
  }
  return {
    addon, park, visible,
    // Suppress page-event auto-registration even if create finishes after timeout.
    isManagedPage: page => page.url().startsWith(PAGE_PREFIX),
    async shouldRegisterUIPage(page) {
      // Playwright can emit page before Firefox commits the create URL.
      if (page.url() === 'about:blank' && page.waitForURL)
        await page.waitForURL(url => url.href !== 'about:blank', { timeout: timeoutMs }).catch(() => {});
      return !page.isClosed() && !page.url().startsWith(PAGE_PREFIX);
    },
    async attach(context) {
      context.once('close', () => { close().catch(() => {}); });
      let timer;
      try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('window parking extension did not start')), timeoutMs); })]); }
      finally { clearTimeout(timer); }
    },
    async newPage(context) {
      const url = `${PAGE_PREFIX}${crypto.randomUUID()}`;
      const target = await command({ action: 'create', url });
      const deadline = Date.now() + timeoutMs;
      let page;
      while (!(page = context.pages().find(candidate => candidate.url() === url && !candidate.isClosed())) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 10));
      if (!page) { await command({ action: 'dispose', ...target }).catch(() => {}); throw new Error('parked page did not become available'); }
      pages.set(page, target); return page;
    },
    async open(page) {
      const target = await locate(page);
      await command({ action: 'show', ...target });
    },
    async release({ all = false, page } = {}) {
      const targets = page ? [await locate(page)] : all ? [...visible.values()] : [...visible.values()].slice(-1);
      // One stale window must not keep every other handoff visible.
      const results = await Promise.allSettled(targets.map(target => command({ action: 'park', ...target })));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, `${failures.length} of ${targets.length} window park operations failed`);
      return targets.length > 0;
    },
    close,
  };
}
