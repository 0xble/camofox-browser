import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { windowBounds, listNativeWindows } from './park-display-launcher.js';
import { findBrowserPid, snapshotDarwinProcesses } from './darwin-processes.js';

const PAGE_PREFIX = 'about:blank#camofox-';

function overlapArea(w, d) {
  return Math.max(0, Math.min(w.left + w.width, d.left + d.width) - Math.max(w.left, d.left))
    * Math.max(0, Math.min(w.top + w.height, d.top + d.height) - Math.max(w.top, d.top));
}
// Same rule as the add-on's isParked: no pixel on main, center and at least
// 95% of the area on the parking display (macOS chrome offsets allowed).
export function nativelyParked(w, { park, main }) {
  const cx = w.left + w.width / 2, cy = w.top + w.height / 2;
  return !overlapArea(w, main) && overlapArea(w, park) / (w.width * w.height) >= 0.95
    && cx >= park.left && cx < park.left + park.width && cy >= park.top && cy < park.top + park.height;
}

// Human handoff is successful only when native bounds put the window on the
// main display. Browser windows.get() is spoofed by Camoufox and cannot prove
// this transition.
export function nativelyOnMain(w, { park, main }) {
  if (!w || ![w.left, w.top, w.width, w.height].every(Number.isFinite) || w.width <= 0 || w.height <= 0) return false;
  const cx = w.left + w.width / 2, cy = w.top + w.height / 2;
  return !overlapArea(w, park) && overlapArea(w, main) / (w.width * w.height) >= 0.5
    && cx >= main.left && cx < main.left + main.width && cy >= main.top && cy < main.top + main.height;
}

export function visibilityAddonFiles({ endpoint, park, main, parkDisplay = park, mainDisplay = main, nativeReadback = false }) {
  return {
    'manifest.json': JSON.stringify({ manifest_version: 2, name: 'Camofox window parking', version: '1.0',
      browser_specific_settings: { gecko: { id: 'camofox-window-parking@camofox.local' } },
      permissions: ['tabs', 'http://127.0.0.1/*'], background: { scripts: ['background.js'] } }),
    'background.js': `const endpoint=${JSON.stringify(endpoint)};
const park=${JSON.stringify(park)},main=${JSON.stringify(main)};
const parkDisplay=${JSON.stringify(parkDisplay)},mainDisplay=${JSON.stringify(mainDisplay)};
const nativeReadback=${JSON.stringify(nativeReadback)};
const done=new Set(),queues=new Map();let polling=false;
async function ack(value){return (await fetch(endpoint,{method:'POST',body:JSON.stringify(value)})).json()}
function overlap(w,d){return Math.max(0,Math.min(w.left+w.width,d.left+d.width)-Math.max(w.left,d.left))*Math.max(0,Math.min(w.top+w.height,d.top+d.height)-Math.max(w.top,d.top))}
function isParked(w){
  return ['left','top','width','height'].every(k=>Number.isFinite(w[k]))&&w.width>0&&w.height>0&&w.state==='normal'
    &&!overlap(w,mainDisplay)&&overlap(w,parkDisplay)/(w.width*w.height)>=0.95
    &&w.left+w.width/2>=parkDisplay.left&&w.left+w.width/2<parkDisplay.left+parkDisplay.width
    &&w.top+w.height/2>=parkDisplay.top&&w.top+w.height/2<parkDisplay.top+parkDisplay.height;
}
async function nativeCheck(windowId,commandId,action){
  // Camoufox spoofs windows.get. The bridge associates this Firefox window
  // with a native window number by a distinct, slightly smaller parking size,
  // never by title or an allowance for some other window.
  const response=await fetch(endpoint+'/geometry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({windowId,commandId:commandId||null,action:action||'park'})});
  const value=await response.json();
  if(!response.ok)throw new Error(value.error||'native geometry readback failed');
  return value;
}
async function parkedNow(windowId,commandId){
  const w=await browser.windows.get(windowId);
  if(!nativeReadback)return {parked:isParked(w),detail:{left:w.left,top:w.top,width:w.width,height:w.height,state:w.state}};
  if(w.state!=='normal')return {parked:false,detail:{state:w.state}};
  // A failed readback is transient (slow osascript, window list mid-update):
  // it counts as not yet verified inside the same bounded loop.
  try{const native=await nativeCheck(windowId,commandId,'park');return {parked:native.parked,bounds:native.bounds,detail:native};}
  catch(e){return {parked:false,detail:{readbackError:String(e&&e.message||e)}};}
}
async function shownNow(windowId,commandId){
  const w=await browser.windows.get(windowId);
  if(!nativeReadback)return {shown:!isParked(w),detail:{left:w.left,top:w.top,width:w.width,height:w.height,state:w.state}};
  if(w.state!=='normal')return {shown:false,detail:{state:w.state}};
  try{const native=await nativeCheck(windowId,commandId,'show');return {shown:native.onMain===true,bounds:native.bounds,detail:native};}
  catch(e){return {shown:false,detail:{readbackError:String(e&&e.message||e)}};}
}
async function verifyPark(windowId,commandId){
  // Firefox can override create coordinates. Each bounded correction is
  // window-local: other callers' handoffs, failures or placement never grant
  // this window a pass, and are never a reason to wait longer.
  let detail;
  for(let attempt=0;attempt<4;attempt++){
    const before=await parkedNow(windowId,commandId);
    if(!before.parked){
      const bounds=before.bounds||park;
      // A native size signature also changes a cached equal-bounds update.
      await browser.windows.update(windowId,nativeReadback&&attempt%2?{...bounds,top:bounds.top+1}:bounds);
    }
    await new Promise(resolve=>setTimeout(resolve,50));
    const result=await parkedNow(windowId,commandId);detail=result.detail;
    if(result.parked)return;
  }
  throw new Error('window '+windowId+' did not park on the parking display: '+JSON.stringify(detail));
}
async function verifyShow(windowId,commandId){
  // A successful human handoff requires native bounds on the main display.
  // Camoufox may report the requested bounds even when the native move was
  // ignored, so never acknowledge show from windows.get alone.
  let detail;
  for(let attempt=0;attempt<4;attempt++){
    const result=await shownNow(windowId,commandId);detail=result.detail;
    if(result.shown)return;
    await browser.windows.update(windowId,attempt&&nativeReadback?{...main,top:main.top+1}:main);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('window '+windowId+' did not move to the main display: '+JSON.stringify(detail));
}
async function movePark(windowId,commandId){await browser.windows.update(windowId,park);await verifyPark(windowId,commandId)}
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
async function perform(c,key){
  let windowId=c.windowId,tabId=c.tabId,created=false,shown=false,wasVisible=false;
  async function undo(){
    if(created)await browser.windows.remove(windowId);
    else if(shown&&!wasVisible){await movePark(windowId);await ack({parked:windowId});}
  }
  try{
    if(c.action==='create'){
      // Camoufox may restart the background page while creating a window. Its
      // controlled URL is a durable command disambiguator across that restart.
      if(!c.realized){
        const existing=(await browser.tabs.query({})).find(t=>t.url===c.url);
        if(existing){windowId=existing.windowId;tabId=existing.id;}
        else{
          if(Date.now()>=c.expiresAt){await ack({id:c.id,error:'expired'});return;}
          const w=await browser.windows.create({...park,url:c.url});windowId=w.id;tabId=w.tabs[0].id;
        }
        // Creation has no window key until Firefox realizes it. All subsequent
        // verification, acknowledgments and rollback share that window's queue.
        enqueue({...c,windowId,tabId,realized:true},windowId);return;
      }
      created=true;
      if(Date.now()>=c.expiresAt){await browser.windows.remove(windowId);await ack({id:c.id,error:'expired'});return;}
      await verifyPark(windowId,c.id);
    }else{
      const t=await target(c);if(!t)return;
      // A tab can move while queued. Transfer work without holding the source
      // queue, then revalidate again when the destination queue reaches it.
      if(t.windowId!==key){enqueue(c,t.windowId);return;}
      windowId=t.windowId;tabId=t.tabId;
      // Read rollback ownership inside the window queue, after prior acknowledgments.
      // An issue-time snapshot can predate a concurrent successful handoff.
      if(c.action==='show')wasVisible=(await(await fetch(endpoint)).json()).visible.includes(windowId);
      if(Date.now()>=c.expiresAt){if(c.action==='show'&&!wasVisible){await movePark(windowId);await ack({parked:windowId});}await ack({id:c.id,error:'expired'});return;}
      if(t.gone){await ack({id:c.id,windowId,tabId:null,gone:true});return;}
      if(c.action==='show'){
        if(tabId!=null)await browser.tabs.update(tabId,{active:true});
        shown=true;
        // Bind an existing parking signature before moving the window. A
        // previous park/classification failure may have left its native
        // number unresolved; after the move, that signature is gone and
        // geometry alone cannot safely identify the window.
        if(nativeReadback)await shownNow(windowId,c.id);
        await browser.windows.update(windowId,main);
        if(nativeReadback)await verifyShow(windowId,c.id);
      }
      else if(c.action==='park')await movePark(windowId,c.id);
      else if(c.action==='dispose')await browser.windows.remove(windowId);
    }
    const result=await ack({id:c.id,windowId,tabId});
    if(!result.accepted)await undo();
  }catch(e){await undo().catch(()=>{});await ack({id:c.id,windowId,...(!created&&c.action==='park'?{parkingFailed:windowId}:{}),error:String(e)}).catch(()=>{});}
}
function queueWindow(key,work){
  const next=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(work);
  queues.set(key,next);
  next.finally(()=>{if(queues.get(key)===next)queues.delete(key)}).catch(()=>{});
  return next;
}
function enqueue(c,key){return queueWindow(key,()=>perform(c,key))}
async function dispatch(c){
  if(done.has(c.id))return;
  let t;
  try{t=c.action==='create'?{windowId:c.id}:await target(c);}catch(e){done.add(c.id);await ack({id:c.id,error:String(e)});return;}
  if(!t)return; // A short locate retry can re-apply an SPA's title marker.
  done.add(c.id);
  enqueue(c.marker?{...c,marker:null,...t}:c,t.windowId);
}
browser.windows.onRemoved.addListener(windowId=>ack({removed:windowId}).catch(()=>{}));
browser.tabs.onRemoved.addListener(async(tabId,info)=>{if(!info||info.isWindowClosing)return;
  try{const [live]=await browser.tabs.query({windowId:info.windowId,active:true});await ack({tabRemoved:tabId,windowId:info.windowId,tabId:live?live.id:null});}catch{}});
async function classifyWindow(windowId){
  const w=await browser.windows.get(windowId,{populate:true}).catch(()=>null);
  if(!w)return;
  const tabs=w.tabs||await browser.tabs.query({windowId});
  const opener=tabs.find(t=>t.openerTabId!=null);
  const source=opener?await browser.tabs.get(opener.openerTabId).catch(()=>null):null;
  // Classify inside the same window queue as show/park, using state after
  // prior acknowledgments, not a startup-wide or event-time snapshot.
  const snapshot=await(await fetch(endpoint)).json();
  if(snapshot.visible.includes(w.id))return;
  const api=tabs.some(t=>(t.url||t.pendingUrl||'').startsWith('${PAGE_PREFIX}'));
  if(snapshot.parked.includes(w.id)){await verifyPark(w.id);await ack({parked:w.id});return;}
  if(api)return; // In-flight API creates are verified by their command, not onCreated.
  // Popups follow their opener's window; only opener-less UI windows (a human
  // pressing New Window during a handoff) follow the global handoff state.
  if(opener?Boolean(source&&snapshot.visible.includes(source.windowId)):snapshot.visible.length){
    // New UI windows can inherit parked profile geometry, even when the opener
    // is shown. Move them to the human's display, never the API parking lane.
    // A failed move to the main display is not a parking failure.
    try{await browser.windows.update(w.id,main);}
    catch(e){await ack({inheritFailed:w.id,error:String(e)}).catch(()=>{});return;}
    await ack({inherited:w.id,tabId:tabs[0]&&tabs[0].id});
  }else{await movePark(w.id);await ack({parked:w.id});}
}
function classify(windowId){return queueWindow(windowId,async()=>{
  try{await classifyWindow(windowId);}
  catch(e){await ack({parkingFailed:windowId,error:String(e)}).catch(()=>{});throw e;}
})}
browser.windows.onCreated.addListener(w=>classify(w.id).catch(()=>{}));
function poll(){setInterval(async()=>{if(polling)return;polling=true;try{const {commands}=await(await fetch(endpoint)).json();const active=new Set(commands.map(c=>c.id));for(const id of done)if(!active.has(id))done.delete(id);for(const c of commands)await dispatch(c);}catch{}finally{polling=false}},50)}
// Start command recovery before startup classification: after a background
// restart, aggregate native verification of an old window may depend on an
// in-flight create parking its new window. Gating polling on that verification
// deadlocks recovery and retries the wrong, already-parked window.
poll();
(async()=>{
  // Every window is classified on its own. One window that cannot be parked
  // is reported and never stops command polling: after a background restart
  // the server has already resolved readiness and would wait forever.
  let failure=null;
  try{
    for(const w of await browser.windows.getAll()){
      try{await classify(w.id);}
      catch(e){failure=failure||e;}
    }
  }catch(e){failure=failure||e;}
  await ack(failure?{readyError:String(failure)}:{ready:true}).catch(()=>{});
})();\n`,
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
    visibility = display ? await createVisibility(display, { log, profilePath }) : null;
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

// Native readback identifies the browser's windows by owner PID, never by
// title: kCGWindowName needs Screen Recording for the TCC-responsible process,
// which a launchd-started server (its own responsible process) lacks.
export function createNativeWindowReadback(profilePath, { platform = os.platform(), rootPid = process.pid,
  snapshot = snapshotDarwinProcesses, list = listNativeWindows, alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } } } = {}) {
  if (platform !== 'darwin' || !profilePath) return null;
  let pid = null;
  return async () => {
    if (pid == null || !alive(pid)) {
      pid = null;
      const processes = snapshot();
      if (!processes) throw new Error('native window readback could not list processes');
      pid = findBrowserPid(rootPid, processes, profilePath);
      if (pid == null) throw new Error(`native window readback found no single browser process for profile ${profilePath}`);
    }
    const windows = await list(pid);
    if (!windows.length) throw new Error(`native window readback found no on-screen windows for browser pid ${pid}`);
    return windows;
  };
}

export async function createSharedIdentityVisibility(display, { rootDir = path.join(os.tmpdir(), 'camofox-window-parking'), timeoutMs = 10000, log, profilePath, nativeReadback = createNativeWindowReadback(profilePath) } = {}) {
  await cleanupVisibilityAddons(rootDir);
  const secret = crypto.randomBytes(32).toString('hex');
  const pending = new Map(), expired = new Map(), visible = new Map(), parked = new Set(), parkingFailures = new Map(), inheritFailures = new Set(), nativeWindows = new Map(), pages = new WeakMap(), locating = new WeakMap();
  let sequence = 0;
  let readyResolve, closing;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url === `/${secret}/geometry` && req.method === 'POST' && nativeReadback) {
      res.setHeader('Content-Type', 'application/json');
      try {
        let text = '';
        for await (const chunk of req) { text += chunk; if (text.length > 1024) throw Error('geometry request too large'); }
        const { windowId, commandId = null, action = 'park' } = JSON.parse(text);
        if (!Number.isSafeInteger(windowId) || windowId < 0) throw Error('invalid geometry window');
        if (commandId !== null && typeof commandId !== 'string') throw Error('invalid geometry command');
        if (!['park', 'show'].includes(action)) throw Error('invalid geometry action');
        const windows = (await nativeReadback()).filter(w => w.width >= 64 && w.height >= 64);
        let target = nativeWindows.get(windowId);
        if (!target) {
          // Native numbers have no Firefox id. Give each unassociated window
          // an unused size signature, then bind only the native window which
          // actually takes it on DeskPad. Exclude current native sizes as well
          // as assigned signatures, so a pre-existing parked window cannot be
          // mistaken for a new one whose update was ignored. Allocation is
          // synchronous after readback: no lock, lease, queue or caller wait.
          const occupied = new Set([...windows, ...nativeWindows.values()].map(w => `${w.width}x${w.height}`));
          for (let dh = 1; dh <= Math.min(64, park.height - 64) && !target; dh++)
            for (let dw = 1; dw <= Math.min(64, park.width - 64); dw++) {
              const width = park.width - dw, height = park.height - dh;
              if (!occupied.has(`${width}x${height}`)) { target = { width, height, number: null }; break; }
            }
          if (!target) throw Error('no unused native parking size');
          nativeWindows.set(windowId, target);
        }
        if (target.number == null) {
          const matches = windows.filter(w => w.width === target.width && w.height === target.height && nativelyParked(w, display));
          if (matches.length === 1 && ![...nativeWindows.values()].some(other => other.number === matches[0].number))
            target.number = matches[0].number;
        }
        const actual = windows.find(w => w.number === target.number);
        return res.end(JSON.stringify({ parked: Boolean(actual && nativelyParked(actual, display)),
          ...(action === 'show' ? { onMain: Boolean(actual && nativelyOnMain(actual, display)) } : {}),
          bounds: { ...park, width: target.width, height: target.height }, number: target.number, actual: actual || null }));
      } catch (error) {
        log?.('warn', 'native window readback failed', { error: error.message });
        res.writeHead(500); return res.end(JSON.stringify({ error: String(error) }));
      }
    }
    if (req.url !== `/${secret}`) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify({ commands: [...expired.values(), ...[...pending.values()].map(entry => entry.command)].sort((a, b) => a.sequence - b.sequence), visible: [...visible.keys()], parked: [...parked] }));
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = '';
    try {
      for await (const chunk of req) { body += chunk; if (body.length > 65536) { res.writeHead(413); return res.end(); } }
      const value = JSON.parse(body);
      if (value.ready) readyResolve();
      if (value.readyError) readyResolve(new Error(value.readyError));
      if (value.error && value.inheritFailed == null) log?.('warn', 'window parking operation failed', { windowId: value.parkingFailed ?? value.windowId, error: value.error });
      if (value.inheritFailed != null) {
        inheritFailures.add(value.inheritFailed);
        log?.('warn', 'window could not be moved to the main display', { windowId: value.inheritFailed, error: value.error });
      }
      if (value.parkingFailed != null) { parked.delete(value.parkingFailed); parkingFailures.set(value.parkingFailed, value.error); }
      if (value.removed != null) { visible.delete(value.removed); parked.delete(value.removed); parkingFailures.delete(value.removed); inheritFailures.delete(value.removed); nativeWindows.delete(value.removed); }
      // Re-key a handoff whose tab closed inside a surviving window to the window itself.
      if (value.tabRemoved != null && visible.get(value.windowId)?.tabId === value.tabRemoved)
        visible.set(value.windowId, { windowId: value.windowId, tabId: value.tabId ?? null });
      if (value.parked != null) { visible.delete(value.parked); parked.add(value.parked); parkingFailures.delete(value.parked); }
      if (value.inherited != null) {
        parked.delete(value.inherited); inheritFailures.delete(value.inherited); visible.set(value.inherited, { windowId: value.inherited, tabId: value.tabId });
      }
      const entry = pending.get(value.id);
      expired.delete(value.id);
      const accepted = Boolean(entry && Date.now() < entry.command.expiresAt && !value.error);
      if (entry) {
        pending.delete(value.id); clearTimeout(entry.timer);
        if (!accepted) entry.reject(new Error(value.error || 'window visibility operation failed'));
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
    for (const [name, contents] of Object.entries(visibilityAddonFiles({ endpoint, park, main, parkDisplay: display.park, mainDisplay: display.main, nativeReadback: Boolean(nativeReadback) })))
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
    addon, park, visible, parkingFailures, inheritFailures,
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
      try {
        const error = await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('window parking extension did not start')), timeoutMs); })]);
        if (error) throw error;
      }
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
    async release({ all = false, page, keep = [] } = {}) {
      // Resolve each kept page's current window; if any cannot be resolved,
      // park nothing rather than risk moving a person's window.
      const kept = new Set();
      for (const target of await Promise.all(keep.map(async p => command({ action: 'locate', ...(await locate(p)) }))))
        kept.add(target.windowId);
      const windows = [...visible.keys()].filter(windowId => !kept.has(windowId)).map(windowId => ({ windowId }));
      const targets = page ? [await locate(page)] : all ? windows : windows.slice(-1);
      // One stale window must not keep every other handoff visible.
      const results = await Promise.allSettled(targets.map(target => command({ action: 'park', ...target })));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, `${failures.length} of ${targets.length} window park operations failed`);
      return targets.length > 0;
    },
    close,
  };
}
