// A headless Chrome to drive the page with, over the DevTools protocol, for scripts/check-page.ts and any one-off
// harness. Chrome picks its own debugging port (--remote-debugging-port=0, read back from DevToolsActivePort in a
// fresh profile), so any number of these can run at once without colliding.
//
//   const b = await launch();                        // CHROME=/path/to/chrome to choose the binary
//   const p = b.page;                                 // the one tab
//   await p.phone();                                  // iPhone metrics, touch, coarse pointer (before goto)
//   await p.blockWebSockets();                        // no socket ever opens (before goto); see below
//   await p.goto('http://127.0.0.1:8787/short-stay-library');
//   await p.eval(`document.title`); await p.waitFor(`!document.getElementById('map').hidden`);
//   await p.press('KeyM'); await p.hold(['ShiftLeft', 'KeyW'], 3000); await p.tap(10, 10);
//   p.errors, p.csp, p.frames, p.sockets;  await p.screenshot('x.png');  await b.close();
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const CHROMES = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

export interface Frame { dir: 'sent' | 'received'; url: string; data: string; t: number }
export interface LaunchOptions { args?: string[]; width?: number; height?: number; chrome?: string; timeoutMs?: number }

// Keys by DOM code: what Input.dispatchKeyEvent wants besides the code.
const KEYS: Record<string, [string, number]> = {
  ShiftLeft: ['Shift', 16], ShiftRight: ['Shift', 16], ControlLeft: ['Control', 17], AltLeft: ['Alt', 18], MetaLeft: ['Meta', 91],
  Escape: ['Escape', 27], Enter: ['Enter', 13], Space: [' ', 32], Tab: ['Tab', 9], Backspace: ['Backspace', 8],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Slash: ['/', 191], Period: ['.', 190], Comma: [',', 188], Minus: ['-', 189], Equal: ['=', 187], BracketLeft: ['[', 219], BracketRight: [']', 221],
};
const keyOf = (code: string): [string, number] => KEYS[code] ?? (/^Key[A-Z]$/.test(code) ? [code[3].toLowerCase(), code.charCodeAt(3)]
  : /^Digit\d$/.test(code) ? [code[5], code.charCodeAt(5)] : [code, 0]);
const SHIFTED: Record<string, string> = { Slash: '?', Period: '>', Comma: '<', Minus: '_', Equal: '+' };

// A stand-in for WebSocket that never touches the network: it reports the attempt (window.__wsBlocked), then fails
// like a refused connection would (error, then close 1006), and drops anything sent.
const NO_SOCKETS = `(() => {
  const tried = window.__wsBlocked = [];
  class BlockedSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url, protocols) {
      super(); this.url = String(url); this.protocol = ''; this.extensions = ''; this.binaryType = 'blob'; this.bufferedAmount = 0;
      this.readyState = 0; this.onopen = this.onmessage = this.onerror = this.onclose = null; tried.push(this.url);
      setTimeout(() => {
        this.readyState = 3;
        const err = new Event('error'); this.dispatchEvent(err); if (this.onerror) this.onerror(err);
        const close = new CloseEvent('close', { code: 1006, reason: 'blocked by the test harness', wasClean: false }); this.dispatchEvent(close); if (this.onclose) this.onclose(close);
      }, 0);
    }
    send() {} close() { this.readyState = 3; }
  }
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) BlockedSocket.prototype[k] = BlockedSocket[k];
  Object.defineProperty(window, 'WebSocket', { value: BlockedSocket, writable: false, configurable: false });
})();`;

// Reports CSP violations through a binding, which outlives navigations.
const WATCH_CSP = `document.addEventListener('securitypolicyviolation', e => { try { __cdpReport(JSON.stringify({ kind: 'csp', directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile + ':' + e.lineNumber })); } catch {} });`;

export class Page {
  errors: string[] = [];              // exceptions, console.error, and error-level log entries (failed loads and the like)
  csp: string[] = [];                 // Content-Security-Policy violations
  frames: Frame[] = [];               // WebSocket frames, both ways
  sockets: string[] = [];             // WebSockets the network saw created
  logs: string[] = [];                // console warnings and info, for context
  private id = 0;
  private waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  private listeners = new Map<string, ((p: any) => void)[]>();
  private socketUrls = new Map<string, string>();
  private ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data));
      if (m.id) { const w = this.waiting.get(m.id); this.waiting.delete(m.id); if (w) m.error ? w.no(new Error(`${m.error.message} (${m.error.code})`)) : w.ok(m.result); return; }
      this.record(m.method, m.params);
      for (const f of this.listeners.get(m.method) ?? []) f(m.params);
    };
  }
  private record(method: string, p: any) {
    const t = Date.now();
    if (method === 'Runtime.exceptionThrown') this.errors.push('exception: ' + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
    else if (method === 'Runtime.consoleAPICalled') {
      const text = p.args.map((a: any) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300);
      if (p.type === 'error' || p.type === 'assert') this.errors.push('console: ' + text); else this.logs.push(`${p.type}: ${text}`);
    } else if (method === 'Log.entryAdded') {
      const e = p.entry;
      if (/Content.Security.Policy/i.test(e.text)) this.csp.push(e.text);
      else if (e.level === 'error') this.errors.push(`${e.source}: ${e.text}${e.url ? ' ' + e.url : ''}`);
    } else if (method === 'Runtime.bindingCalled' && p.name === '__cdpReport') {
      const r = JSON.parse(p.payload); if (r.kind === 'csp') this.csp.push(`${r.directive} blocked ${r.blocked} (${r.source})`);
    } else if (method === 'Network.webSocketCreated') { this.sockets.push(p.url); this.socketUrls.set(p.requestId, p.url); }
    else if (method === 'Network.webSocketFrameSent') this.frames.push({ dir: 'sent', url: this.socketUrls.get(p.requestId) ?? '', data: p.response.payloadData, t });
    else if (method === 'Network.webSocketFrameReceived') this.frames.push({ dir: 'received', url: this.socketUrls.get(p.requestId) ?? '', data: p.response.payloadData, t });
  }
  // the raw protocol, for anything not wrapped here
  send(method: string, params: object = {}): Promise<any> {
    return new Promise((ok, no) => { const id = ++this.id; this.waiting.set(id, { ok, no }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method: string, f: (params: any) => void) { this.listeners.set(method, [...(this.listeners.get(method) ?? []), f]); }
  async init() {
    for (const d of ['Runtime', 'Page', 'Network', 'Log']) await this.send(`${d}.enable`);
    await this.send('Runtime.addBinding', { name: '__cdpReport' });
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH_CSP });
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });   // key events land though no window has focus
  }
  // Run an expression (awaited when it is a promise) and return its value; a throw in the page throws here.
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  // Poll an expression until it is truthy; its value, or an error after timeoutMs.
  async waitFor<T = any>(expression: string, timeoutMs = 10000, everyMs = 100): Promise<T> {
    const end = Date.now() + timeoutMs; let last: unknown;
    for (;;) {
      try { const v = await this.eval<T>(expression); if (v) return v; last = v; } catch (e) { last = e; }
      if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${expression} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
      await sleep(everyMs);
    }
  }
  // Navigate and wait for the load event.
  async goto(url: string, timeoutMs = 20000) {
    const loaded = new Promise<void>(r => this.on('Page.loadEventFired', () => r()));
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) throw new Error(`${url}: ${r.errorText}`);
    await Promise.race([loaded, sleep(timeoutMs).then(() => { throw new Error(`${url}: no load event in ${timeoutMs} ms`); })]);
  }
  // Keys by DOM code ('KeyW', 'ShiftLeft', 'Slash', 'Escape'…). shift: the shifted key ('?' for Slash).
  async keyDown(code: string, shift = false) {
    const [k, vk] = keyOf(code), key = shift ? (SHIFTED[code] ?? k.toUpperCase()) : k;
    await this.send('Input.dispatchKeyEvent', { type: key.length === 1 ? 'keyDown' : 'rawKeyDown', code, key, windowsVirtualKeyCode: vk, ...(key.length === 1 ? { text: key } : {}), modifiers: shift ? 8 : 0 });
  }
  async keyUp(code: string, shift = false) {
    const [k, vk] = keyOf(code), key = shift ? (SHIFTED[code] ?? k.toUpperCase()) : k;
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk, modifiers: shift ? 8 : 0 });
  }
  async press(code: string, shift = false) { if (shift) await this.keyDown('ShiftLeft'); await this.keyDown(code, shift); await this.keyUp(code, shift); if (shift) await this.keyUp('ShiftLeft'); }
  // Hold several keys down together for ms, then let go in reverse order.
  async hold(codes: string[], ms: number) {
    const shift = codes.some(c => c.startsWith('Shift'));
    for (const c of codes) await this.keyDown(c, shift && !c.startsWith('Shift'));
    await sleep(ms);
    for (const c of [...codes].reverse()) await this.keyUp(c, shift && !c.startsWith('Shift'));
  }
  async click(x: number, y: number) {
    for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  // A finger: down and up at one point (with touch emulated, a tap is also a click).
  async tap(x: number, y: number) {
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  // An iPhone (15): its viewport and pixel ratio, touch, a coarse pointer and no hover, and Safari's user agent.
  async phone() {
    await this.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await this.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    await this.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone' });
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'any-hover', value: 'none' }] });
  }
  // Requests to these URL patterns (* wildcards) fail. Not WebSockets: the network blocklist doesn't see those.
  async blockURLs(urls: string[]) { await this.send('Network.setBlockedURLs', { urls }); }
  // No WebSocket opens from this page, from the next navigation on: window.WebSocket is replaced, before any of the
  // page's scripts run, by one that fails at once without touching the network. (Network.setBlockedURLs and the
  // Fetch domain don't stop WebSockets.) Attempts are listed in window.__wsBlocked; p.sockets stays empty.
  async blockWebSockets() { await this.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_SOCKETS }); }
  async screenshot(path: string) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path, Buffer.from(r.data, 'base64')); }
  sent(type?: string) { return this.frames.filter(f => f.dir === 'sent' && (!type || frameType(f) === type)); }
  received(type?: string) { return this.frames.filter(f => f.dir === 'received' && (!type || frameType(f) === type)); }
}
// a protocol frame's type: JSON text frames with a `t` (web/protocol.js)
export const frameType = (f: Frame) => { try { return JSON.parse(f.data).t as string; } catch { return undefined; } };

export interface Browser { page: Page; port: number; close(): Promise<void> }

export async function launch(o: LaunchOptions = {}): Promise<Browser> {
  const bin = o.chrome ?? process.env.CHROME ?? CHROMES.find(existsSync);
  if (!bin) throw new Error('no Chrome found: set CHROME=/path/to/chrome');
  const dir = mkdtempSync(join(tmpdir(), 'check-page-'));
  const chrome: ChildProcess = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--window-size=${o.width ?? 1100},${o.height ?? 900}`, ...(o.args ?? []), 'about:blank'], { stdio: 'ignore' });
  const dead = () => { try { chrome.kill(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  try {
    // Chrome writes the port it bound, and the browser's socket path, to DevToolsActivePort in the profile
    const file = join(dir, 'DevToolsActivePort'), end = Date.now() + (o.timeoutMs ?? 15000);
    let port = 0;
    while (!port) {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited (${chrome.exitCode}) before it was ready`);
      if (Date.now() > end) throw new Error('Chrome did not write DevToolsActivePort in time');
      try { port = Number(readFileSync(file, 'utf8').split('\n')[0]) || 0; } catch {}
      if (!port) await sleep(50);
    }
    let target: any;
    for (let i = 0; i < 100 && !target; i++) {
      try { target = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]).find(t => t.type === 'page'); } catch {}
      if (!target) await sleep(100);
    }
    if (!target) throw new Error(`no page target on port ${port}`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error('could not attach to the page')); });
    const page = new Page(ws); await page.init();
    return { page, port, async close() { try { ws.close(); } catch {} dead(); } };
  } catch (e) { dead(); throw e; }
}
