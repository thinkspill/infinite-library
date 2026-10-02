// Load test: N people walking about near the spawn, talking to the world the way the page does (web/session.js: a move
// report when their course changes or every 2 s), plus a ping every 5 s to time the world's answers, for a while. Reports how many got in, how quickly the
// world answers (ping round trips), and how much it sends. Everyone crowds within ~100 m of one floor and its
// neighbours, so every socket sees the most peers it can (32): the world's worst case for fan-out.
// Run against a dev server: node scripts/load.ts [people] [seconds] [base-url]
import * as P from '../web/protocol.js';
import { createSession, memoryStorage } from '../web/session.js';
const N = Number(process.argv[2] ?? 100), SECS = Number(process.argv[3] ?? 40), BASE = process.argv[4] ?? 'http://127.0.0.1:8787';
const run = Math.random().toString(36).slice(2, 7), sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Msg = Record<string, any>;
const rtts: number[] = [];
let full = 0, welcomed = 0, corrected = 0, sent = 0, got = 0, gotBytes = 0, peersMsgs = 0, errors = 0;

function person(i: number) {
  return new Promise<void>(async done => {
    // arrivals spread over RAMP seconds (default 0: all at once), as a real crowd would trickle in
    await sleep(Math.random() * Number(process.env.RAMP ?? 0) * 1000);
    // each person from their own (made-up) address, as a crowd would be: the world limits sockets and arrivals per
    // address. One session each (web/session.js, the page's own client), which decides when a move report is due.
    const s = createSession({
      url: BASE.replace(/^http/, 'ws') + '/ws', reconnect: false, wsOptions: { headers: { 'CF-Connecting-IP': `198.18.${(i >> 8) & 255}.${i & 255}` } },
      storage: memoryStorage({ anon: `load-${run}-${i}-xxxxxxxx`, name: `Load ${i}` }),
    });
    let x = -3.2, y = 0, floor = 0, side = 0, dir = Math.random() < 0.5 ? 1 : -1, live = true, welcome: () => void;
    const welcomeSeen = new Promise<void>(r => welcome = r);
    const pings = new Map<number, number>();
    const ws = () => s.ws as WebSocket | null;
    const send = (m: object) => { if (s.online) { s.send(m); sent++; } };
    s.on('open', () => sent++);   // the hello
    s.on('message', (m: Msg) => {
      got++; gotBytes += JSON.stringify(m).length;
      if (m.t === 'welcome') { welcomed++; side = m.you.side; floor = m.you.floor; y = m.you.y; welcome(); }
      else if (m.t === 'full') { full++; live = false; welcome(); }   // turned away: walk alone, i.e. leave
      else if (m.t === 'correct') { corrected++; x = m.x; y = m.y; floor = m.floor; }
      else if (m.t === 'peers') peersMsgs++;
      else if (m.t === 'pong') { const t0 = pings.get(m.at0); if (t0) rtts.push(performance.now() - t0); }
      else if (m.t === 'error') { errors++; if (errors <= 3) console.log('error:', JSON.stringify(m)); }
    });
    s.on('close', () => { live = false; done(); });
    s.on('socketError', () => { if (live) errors++; });
    s.connect();
    (async () => {
      await welcomeSeen; await sleep(Math.random() * 1000);
      const end = Date.now() + SECS * 1000;
      let t = 0;
      while (live && ws()?.readyState === 1 && Date.now() < end) {
        // walk 1.5 m/s, turning round now and then; the session reports a turn at once, and otherwise every 2 s
        const turned = Math.random() < 0.1; if (turned) dir = -dir;
        const vy = 1.5 * dir; y += vy;
        if (process.env.MOVES !== '0' && s.tick(1, { x, y, floor, side, yaw: dir > 0 ? 1.57 : -1.57, vx: 0, vy, reading: false })) sent++;
        if (++t % 5 === 0) { const at0 = performance.now(); pings.set(Math.round(at0), at0); send(P.ping(Math.round(at0))); }
        await sleep(1000);
      }
      live = false; s.close();
    })();
  });
}

console.log(`${N} people for ${SECS} s against ${BASE} …`);
const t0 = Date.now();
await Promise.all(Array.from({ length: N }, (_, i) => person(i)));
const secs = (Date.now() - t0) / 1000, q = (p: number) => { const s = [...rtts].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(0) : '–'; };
console.log(`in: ${welcomed} welcomed, ${full} turned away (full), ${errors} errors, ${corrected} corrections`);
console.log(`world round trip (ping): p50 ${q(0.5)} ms · p95 ${q(0.95)} ms · p99 ${q(0.99)} ms (${rtts.length} pings)`);
console.log(`to the world: ${(sent / secs).toFixed(0)} msg/s (${(sent / secs / Math.max(1, welcomed)).toFixed(2)} per person)`);
console.log(`from the world: ${(got / secs).toFixed(0)} msg/s, ${(gotBytes / secs / 1024).toFixed(0)} KB/s; peers updates ${(peersMsgs / secs / Math.max(1, welcomed)).toFixed(2)}/s per person`);
process.exit(0);
