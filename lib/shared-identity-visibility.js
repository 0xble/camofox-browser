import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { windowBounds } from './park-display-launcher.js';

export function visibilityAddonFiles({ endpoint, park, main }) {
  return {
    'manifest.json': JSON.stringify({ manifest_version: 2, name: 'Camofox window parking', version: '1.0',
      browser_specific_settings: { gecko: { id: 'camofox-window-parking@camofox.local' } },
      permissions: ['tabs', 'http://127.0.0.1/*'], background: { scripts: ['background.js'] } }),
    'background.js': `const endpoint=${JSON.stringify(endpoint)};
const park=${JSON.stringify(park)},main=${JSON.stringify(main)};
const done=new Set();let polling=false;
async function ack(value){await fetch(endpoint,{method:'POST',body:JSON.stringify(value)})}
async function perform(c){
  if(done.has(c.id))return;
  let windowId=c.windowId,tabId=c.tabId;
  if(c.marker){const tabs=await browser.tabs.query({title:c.marker});if(tabs.length!==1)return;windowId=tabs[0].windowId;tabId=tabs[0].id;}
  done.add(c.id);
  try{
    if(c.action==='create'){const existing=(await browser.tabs.query({})).find(t=>t.url===c.url);if(existing){windowId=existing.windowId;tabId=existing.id;}else{const w=await browser.windows.create({...park,url:c.url});windowId=w.id;tabId=w.tabs[0].id;}}
    else if(c.action==='show'){if(tabId!=null)await browser.tabs.update(tabId,{active:true});await browser.windows.update(windowId,main);}
    else if(c.action==='park'){await browser.windows.update(windowId,park);}
    await ack({id:c.id,windowId,tabId});
  }catch(e){await ack({id:c.id,error:String(e)})}
}
browser.windows.onRemoved.addListener(windowId=>ack({removed:windowId}).catch(()=>{}));
browser.windows.onCreated.addListener(async w=>{try{const snapshot=await(await fetch(endpoint)).json();if(!snapshot.visible.includes(w.id))await browser.windows.update(w.id,park);}catch{}});
(async()=>{const snapshot=await(await fetch(endpoint)).json();for(const w of await browser.windows.getAll())if(!snapshot.visible.includes(w.id))await browser.windows.update(w.id,park);await ack({ready:true});
setInterval(async()=>{if(polling)return;polling=true;try{const {commands}=await(await fetch(endpoint)).json();const active=new Set(commands.map(c=>c.id));for(const id of done)if(!active.has(id))done.delete(id);await Promise.all(commands.map(perform));}catch{}finally{polling=false}},50)})();\n`,
  };
}

export async function prepareParkedProfile(profilePath, display) {
  const file = path.join(profilePath, 'xulstore.json');
  const data = JSON.parse(await fs.readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  }));
  const key = 'chrome://browser/content/browser.xhtml';
  data[key] ||= {};
  data[key]['main-window'] = { ...data[key]['main-window'],
    screenX: String(display.left), screenY: String(display.top),
    width: String(display.width), height: String(display.height), sizemode: 'normal' };
  const staging = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(staging, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(staging, file);
}

export async function createSharedIdentityVisibility(display, { rootDir = path.join(os.tmpdir(), 'camofox-window-parking'), timeoutMs = 10000 } = {}) {
  const secret = crypto.randomBytes(32).toString('hex');
  const pending = new Map();
  const visible = new Map();
  const pages = new WeakMap();
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url !== `/${secret}`) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify({ commands: [...pending.values()].map(entry => entry.command), visible: [...visible.keys()] }));
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) { res.writeHead(413); return res.end(); }
      }
      const value = JSON.parse(body);
      if (value.ready) readyResolve();
      if (value.removed != null) visible.delete(value.removed);
      const entry = pending.get(value.id);
      if (entry) {
        pending.delete(value.id);
        clearTimeout(entry.timer);
        if (value.error) entry.reject(new Error('window visibility operation failed'));
        else entry.resolve({ windowId: value.windowId, tabId: value.tabId });
      }
      res.end('{}');
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const endpoint = `http://127.0.0.1:${server.address().port}/${secret}`;
  const park = windowBounds(display.park);
  const main = windowBounds(display.main, true);
  const addon = path.join(rootDir, crypto.randomUUID());
  await fs.mkdir(addon, { recursive: true, mode: 0o700 });
  for (const [name, contents] of Object.entries(visibilityAddonFiles({ endpoint, park, main }))) {
    await fs.writeFile(path.join(addon, name), contents, { mode: 0o600 });
  }
  function command(payload) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('window visibility operation timed out')); }, timeoutMs);
      pending.set(id, { command: { id, ...payload }, resolve, reject, timer });
    });
  }
  async function locate(page) {
    const known = pages.get(page);
    if (known) return known;
    // Only legacy/UI-created pages need a temporary own-page title marker.
    // Normal automation pages are associated at creation, without page edits.
    const marker = `camofox-window-${crypto.randomUUID()}`;
    const previous = await page.evaluate(value => { const old = document.title; document.title = value; return old; }, marker);
    try {
      const target = await command({ action: 'locate', marker });
      pages.set(page, target);
      return target;
    } finally {
      await page.evaluate(({ marker, previous }) => { if (document.title === marker) document.title = previous; }, { marker, previous }).catch(() => {});
    }
  }
  async function close() {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('window context closed')); }
    pending.clear();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(addon, { recursive: true, force: true });
  }
  return {
    addon, park, visible,
    async attach(context) {
      context.once('close', () => { close().catch(() => {}); });
      let timer;
      try {
        await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('window parking extension did not start')), timeoutMs); })]);
      } finally { clearTimeout(timer); }
    },
    async newPage(context) {
      const url = `about:blank#camofox-${crypto.randomUUID()}`;
      const target = await command({ action: 'create', url });
      const deadline = Date.now() + timeoutMs;
      let page;
      while (!(page = context.pages().find(candidate => candidate.url() === url && !candidate.isClosed())) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!page) throw new Error('parked page did not become available');
      pages.set(page, target);
      return page;
    },
    async open(page) {
      const target = await locate(page);
      await command({ action: 'show', ...target });
      visible.delete(target.windowId);
      visible.set(target.windowId, target);
    },
    async release({ all = false } = {}) {
      const targets = all ? [...visible.values()] : [...visible.values()].slice(-1);
      await Promise.all(targets.map(async target => {
        await command({ action: 'park', ...target });
        if (visible.get(target.windowId) === target) visible.delete(target.windowId);
      }));
      return targets.length > 0;
    },
    close,
  };
}
