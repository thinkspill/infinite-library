// Checks the page in a real (headless) Chrome against a running server: desktop, phone and walking. Uses
// scripts/browser.ts, so several runs at once don't collide.
// Run: node scripts/check-page.ts [base]        base defaults to http://127.0.0.1:8787 (npm run dev)
//      node scripts/check-page.ts --prod [base] production (https://library.short-stay.workers.dev): read-only
// A page that connects joins the world as a player, so --prod is required for any non-local base, and with it no
// WebSocket can open (window.WebSocket is replaced before the page runs; checked: no socket, no 'hello' frame sent).
// Options: --only=desktop,phone,walk   --shots=<dir> to save screenshots.
import { launch, sleep, frameType, type Page } from './browser.ts';

const args = process.argv.slice(2), flag = (n: string) => args.find((a: string) => a === `--${n}` || a.startsWith(`--${n}=`));
const PROD = !!flag('prod'), BASE = (args.find((a: string) => !a.startsWith('--')) ?? (PROD ? 'https://library.short-stay.workers.dev' : 'http://127.0.0.1:8787')).replace(/\/$/, '');
const ONLY = flag('only')?.split('=')[1]?.split(',') ?? ['desktop', 'phone', 'walk'], SHOTS = flag('shots')?.split('=')[1];
const URL_ = `${BASE}/short-stay-library`;
if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(BASE) && !PROD) {
  console.error(`${BASE} is not a local server: the page would join that world as a player. Pass --prod to check it read-only (no WebSocket).`);
  process.exit(2);
}

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; return !!ok; };
const tryStep = async (what: string, f: () => Promise<unknown>) => { try { return check(await f(), what); } catch (e) { return check(false, `${what}: ${(e as Error).message}`); } };
const shot = (p: Page, name: string) => SHOTS ? p.screenshot(`${SHOTS}/${name}.png`) : Promise.resolve();
const shown = (id: string) => `(() => { const e = document.getElementById('${id}'); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`;
const hidden = (id: string) => `!${shown(id)}`;
const hud = async (p: Page) => p.eval<{ floor: number; unit: number; text: string }>(`(() => { const t = id => document.getElementById(id).textContent;
  const n = s => Number(s.replace(/[−]/g, '-').replace(/[^0-9-]/g, ''));
  return { floor: n(t('hFloor')), unit: n(t('hUnit')), text: t('hSide') + ' / ' + t('hFloor') + ' / ' + t('hUnit') }; })()`);

// A fresh browser per scenario: its own profile, its own player.
async function scenario(name: string, phone: boolean, body: (p: Page) => Promise<void>) {
  console.log(`\n${name}${PROD ? ' (read-only: no WebSocket)' : ''}`);
  const b = await launch();
  try {
    const p = b.page;
    if (phone) await p.phone();
    if (PROD) await p.blockWebSockets();
    await tryStep(`loads ${URL_}`, async () => { await p.goto(URL_); return p.waitFor(`document.getElementById('enter') && !document.getElementById('enter').disabled`); });
    await body(p);
    await sleep(300);
    p.errors = p.errors.filter(e => !/\/favicon\.ico\b/.test(e));   // the page has no favicon; browsers ask anyway
    check(!p.errors.length, `no errors${p.errors.length ? ':\n       ' + p.errors.slice(0, 8).join('\n       ') : ''}`);
    check(!p.csp.length, `no CSP violations${p.csp.length ? ':\n       ' + p.csp.slice(0, 8).join('\n       ') : ''}`);
    if (PROD) {
      const tried = await p.eval<string[]>('window.__wsBlocked || []');
      check(!p.sockets.length && !p.sent('hello').length && !p.frames.length, `no WebSocket opened, no 'hello' sent (the page tried ${tried.length}: ${tried.join(', ') || 'none'})`);
    }
  } finally { await b.close(); }
}

async function enter(p: Page) {
  await p.eval(`document.getElementById('enter').click()`);
  await p.waitFor(`document.getElementById('entry').classList.contains('hidden')`);
  if (!PROD) await tryStep('joins the world (online)', () => p.waitFor(`!/^Alone|another tab|Crowded/.test(document.getElementById('hNet').textContent)`, 10000));
}

async function desktop() {
  await scenario('Desktop', false, async p => {
    await enter(p);
    await tryStep('search "hello world" → "Read it from here" opens the reader', async () => {
      await p.press('Slash'); await p.waitFor(shown('finder-dlg'), 3000);
      await p.eval(`(() => { const t = document.getElementById('fText'); t.value = 'hello world'; t.dispatchEvent(new Event('input')); })()`);
      await p.waitFor(`!document.getElementById('fGo').disabled`, 3000); await p.eval(`document.getElementById('fGo').click()`);
      await p.waitFor(`[...document.querySelectorAll('#fOut button')].some(b => b.textContent === 'Read it from here')`, 10000);
      await p.eval(`[...document.querySelectorAll('#fOut button')].find(b => b.textContent === 'Read it from here').click()`);
      return p.waitFor(`document.getElementById('book').classList.contains('open') && /hello world/.test(document.getElementById('bText').textContent)`, 8000);
    });
    await shot(p, 'desktop-reader');
    await p.press('Escape'); await sleep(300);
    if (!PROD) await tryStep('M opens the map, and M closes it', async () => {
      await p.press('KeyM'); await p.waitFor(shown('map'), 4000); await shot(p, 'desktop-map');
      await p.press('KeyM'); return p.waitFor(hidden('map'), 3000);
    });
    await tryStep('I opens "How it works"', async () => { await p.press('KeyI'); return p.waitFor(shown('how-dlg'), 3000); });
    for (const id of ['proveWalk', 'proveAny', 'proveBook']) await tryStep(`the "${id}" proof passes`, async () => {
      await p.eval(`document.getElementById('${id}').click()`);
      const r = await p.waitFor<string>(`(() => { const o = document.getElementById('${id}Out'); return o.querySelector('.yes') ? 'yes' : o.querySelector('.no') ? 'no: ' + o.textContent : ''; })()`, 15000);
      if (r !== 'yes') throw new Error(r.slice(0, 300)); return true;
    });
    await tryStep('the "any text" proof highlights exactly the text', async () => {
      const m = await p.eval<string>(`document.querySelector('#proveAnyOut mark')?.textContent ?? ''`), want = await p.eval<string>(`document.getElementById('proveText').value.toLowerCase()`);
      return m.replace(/\n/g, '') === want || `${JSON.stringify(m)} vs ${JSON.stringify(want)}`;
    });
    await shot(p, 'desktop-how');
    await p.press('Escape'); await tryStep('Escape closes it', () => p.waitFor(hidden('how-dlg'), 3000));
    await tryStep('? opens help', async () => { await p.press('Slash', true); return p.waitFor(shown('help-dlg'), 3000); });
    await p.press('Escape'); await sleep(200);
    await tryStep('the phrase finder reports "GPU · …" or "CPU · …"', async () => {
      const s = await p.waitFor<string>(`(() => { const s = document.getElementById('nearStatus').textContent; return /^(GPU|CPU)\\b.* · /.test(s) && s; })()`, 20000);
      console.log(`       (${s})`); return true;
    });
  });
}

async function phone() {
  await scenario('Phone (iPhone, touch)', true, async p => {
    await tryStep('touch keys are shown on the entry card', () => p.waitFor(shown('keysTouch'), 3000));
    await enter(p);
    await tryStep('touch controls are shown (walk, find, help)', () => p.waitFor(`${shown('touch')} && ${shown('tWalk')} && ${shown('hTouch')} && ${shown('hFind')} && ${shown('hHelp')}`, 3000));
    const centre = (sel: string) => p.eval<[number, number]>(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    // a point on the dialog's own backdrop, outside its card
    const outside = (id: string) => p.eval<[number, number] | null>(`(() => { const d = document.getElementById('${id}');
      for (const [x, y] of [[4, 4], [innerWidth - 4, 4], [4, innerHeight - 4], [innerWidth - 4, innerHeight - 4], [innerWidth / 2, 4], [innerWidth / 2, innerHeight - 4], [4, innerHeight / 2]])
        if (document.elementFromPoint(x, y) === d) return [x, y];
      return null; })()`);
    const dialogs: [string, string][] = [['hFind', 'finder-dlg'], ['hHelp', 'help-dlg'], ...(PROD ? [] : [['hMap', 'map']] as [string, string][])];
    for (const [btn, dlg] of dialogs) {
      await tryStep(`${btn}: tap opens ${dlg}, its close button closes it`, async () => {
        await p.tap(...await centre(`#${btn}`)); await p.waitFor(shown(dlg), 4000); await shot(p, `phone-${dlg}`);
        await p.tap(...await centre(`#${dlg} > .xclose`)); return p.waitFor(hidden(dlg), 3000);
      });
      await tryStep(`${btn}: a tap outside closes ${dlg}`, async () => {
        await p.tap(...await centre(`#${btn}`)); await p.waitFor(shown(dlg), 4000); await sleep(200);
        const at = await outside(dlg); if (!at) throw new Error('no backdrop showing outside the card to tap');
        await p.tap(...at); return p.waitFor(hidden(dlg), 3000);
      });
    }
    await shot(p, 'phone-world');
  });
}

async function walk() {
  await scenario('Walking', false, async p => {
    await enter(p);
    await sleep(500);
    const before = await hud(p);
    await p.hold(['ShiftLeft', 'KeyW'], 3000); await sleep(1500);
    const after = await hud(p), metres = Math.abs(after.unit - before.unit) + 3.2 * Math.abs(after.floor - before.floor);
    check(metres >= 8, `Shift+W for 3 s moves the HUD ${metres} m (${before.text} → ${after.text}; at least 8)`);
    if (!PROD) {
      const corrections = p.received('correct');
      check(p.sent('move').length > 0, `move reports sent: ${p.sent('move').length}`);
      check(!corrections.length, `no corrections from the server${corrections.length ? ': ' + corrections.slice(0, 3).map(f => f.data).join(' ') : ''}`);
    }
    await shot(p, 'walk');
  });
}

for (const [name, f] of [['desktop', desktop], ['phone', phone], ['walk', walk]] as const) if (ONLY.includes(name)) await f();
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
void frameType;
