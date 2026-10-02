// Watch the live world during a launch: every few minutes, is it up and quick, how much of today's Free-plan allowance
// is used, how many are online, and every name that appeared or changed since the last look (with the command to
// rename or remove one). Problems also raise a macOS notification, so this can sit in a spare terminal.
// Run: node scripts/watch.ts [minutes=3] [base-url]   (reads the owner token from .owner-token, or OWNER_TOKEN)
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const EVERY = Number(process.argv[2]) || 3, BASE = process.argv[3] ?? 'https://library.short-stay.workers.dev';
const TOKEN = process.env.OWNER_TOKEN ?? (existsSync('.owner-token') ? readFileSync('.owner-token', 'utf8').trim() : '');
if (!TOKEN) { console.error('no owner token: put it in .owner-token or OWNER_TOKEN'); process.exit(1); }
const CAP_FALLBACK = 400;   // MAX_HUMANS_DEFAULT in src/world-core.ts, for a world whose diag doesn't say (no `cap` yet)

const pct = (x: number) => `${(100 * x).toFixed(x < 0.1 ? 1 : 0)}%`;
const clock = (t = Date.now()) => new Date(t).toTimeString().slice(0, 8);
const told = new Set<string>();   // each problem notifies once until it clears
function notify(key: string, text: string) {
  console.log(`  !! ${text}`);
  if (told.has(key)) return; told.add(key);
  if (process.platform === 'darwin') execFile('osascript', ['-e', `display notification ${JSON.stringify(text)} with title "Short Stay"`], () => {});
}
const clear = (key: string) => told.delete(key);

async function timed(path: string, init?: RequestInit) {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(15_000) });
    return { ok: r.ok, status: r.status, ms: Math.round(performance.now() - t0), body: r.ok ? await r.json().catch(() => null) : null };
  } catch (e) { return { ok: false, status: 0, ms: Math.round(performance.now() - t0), body: null, error: String(e) }; }
}

let since = Date.now() - 60 * 60_000;   // the first look covers the last hour
async function look() {
  const at = Date.now();
  const page = await timed('/short-stay-library', { method: 'HEAD' }), map = await timed('/api/map');
  const diag = await timed(`/api/admin/diag?since=${since}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  console.log(`\n${clock(at)}  page ${page.status} ${page.ms} ms · world ${map.status} ${map.ms} ms`);
  if (!page.ok) notify('page', `the page is down (${page.status || 'no answer'})`); else clear('page');
  if (!map.ok || !diag.ok) notify('world', `the world isn't answering (${map.status || 'no answer'}): past the daily allowance?`); else clear('world');
  if (map.ok && map.ms > 3000) notify('slow', `the world is slow: ${map.ms} ms`); else clear('slow');
  const d = diag.body as null | { online: number; cap?: number; sockets: number; players: { n: number }; usage: { requests: number; rowsRead: number; rowsWritten: number; ofLimit: Record<'requests' | 'rowsRead' | 'rowsWritten', number> };
    names: { at: number; type: string; id: string; gave: string | null; name: string; side: number; finds: number }[] };
  if (!d) return;
  const u = d.usage, CAP = d.cap ?? CAP_FALLBACK;   // the world's own cap (MAX_HUMANS)
  console.log(`  online ${d.online} of ${CAP} (${d.sockets} sockets) · ${d.players.n} players in all`);
  console.log(`  today (UTC): ${u.requests} requests ${pct(u.ofLimit.requests)} · ${u.rowsWritten} rows written ${pct(u.ofLimit.rowsWritten)} · ${u.rowsRead} read ${pct(u.ofLimit.rowsRead)}  (of the Free plan's daily allowance)`);
  for (const k of ['requests', 'rowsWritten', 'rowsRead'] as const) {
    const f = u.ofLimit[k];
    if (f >= 0.9) notify(`use-${k}`, `${k}: ${pct(f)} of today's allowance; the world stops answering at 100% until 00:00 UTC`);
    else if (f >= 0.7) notify(`use-${k}`, `${k}: ${pct(f)} of today's allowance`);
  }
  if (d.online >= CAP * 0.85) notify('crowd', `${d.online} online: newcomers walk alone past ${CAP}`); else clear('crowd');
  if (d.names.length) {
    console.log(`  ${d.names.length} name${d.names.length === 1 ? '' : 's'} since ${clock(since)}:`);
    for (const n of d.names) console.log(`    ${clock(n.at)} ${n.type === 'arrive' ? 'new    ' : 'renamed'} ${JSON.stringify(n.name).padEnd(36)} ${n.id} · ${['east', 'west'][n.side]}${n.finds ? ` · ${n.finds} finds` : ''}`);
    console.log(`  to rename one: curl -X POST -H "Authorization: Bearer $(cat .owner-token)" -d '{"id":"p_…","rename":"…"}' ${BASE}/api/admin/player   (or "remove": true)`);
  }
  since = at;
}

console.log(`watching ${BASE} every ${EVERY} min; ctrl-c to stop`);
await look();
setInterval(look, EVERY * 60_000);
