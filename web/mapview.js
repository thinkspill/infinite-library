// The map and the board, as data: where everything on the map goes on the canvas, how big and how bright, and which
// finds each board tab lists. Nothing here draws or reads the page's state; the page passes in its map state, where
// you are, the roster, the finds and the board, and paints what comes back (short-stay-library.html's drawWall,
// drawLibrary and drawBoard). scripts/check-mapview.ts checks it.
//
// Two views. The wall: the wall you walk along, face-on as seen from the shaft, at `ppm` pixels a metre around a
// centre (cx metres along the gallery, cz metres up). The library: everything on symmetric-log scales, which the wall
// gives way to when zoomed out past PPM_MIN.
import { FLOOR_PITCH, UNIT_H, SHELF_PITCH, SLOT0, BOOK_W, BOOK_H, shelfZ, slotY, STAIR_PERIOD, STAIR_OFF, STAIR_LEN } from './geometry.js';
import { rarity } from './scan.js';

export const MAP_PPM = 5, PPM_MIN = 0.1, PPM_MAX = 64;   // pixels a metre: opening, least (then the log view), most
export const SPINES_PPM = 12;   // close enough to draw each book
export const PICK_R2 = 81;      // a pointer within 9 px of a find or a person picks it

// symmetric log: the first ten metres and the ten-thousandth both show
export const slog = v => Math.sign(v) * Math.log10(1 + Math.abs(v));

// ---------------------------------------------------------------- what is on the map
// People on this wall: everyone at the gallery's side of the railing (those over it, x > 0, are in the shaft) on
// your side, and you, if you are at the gallery's side too. viewer: { x, y, floor, side }.
export function wallPeople(roster, viewer, meId) {
  const people = roster.filter(p => p.id !== meId && !(p.x > 0) && (p.side || 0) === viewer.side).map(p => ({ ...p, me: false }));
  if (viewer.x <= 0) people.push({ me: true, y: viewer.y, floor: viewer.floor, present: true, kind: 'human', name: 'you' });
  return people;
}
// The finds the map shows: the fetched top finds if there are any, else the board's; on your side only.
export const sideFinds = (finds, side) => finds.filter(f => (f.side || 0) === side);

// Brightness (a, 0.28..1) and radius (r, px) from rarity, against the rarest and commonest find in `list`; t is 0..1.
export function findLook(list) {
  const rs = list.map(rarity), lo = Math.min(...rs), hi = Math.max(...rs);
  return f => { const t = hi > lo ? (rarity(f) - lo) / (hi - lo) : 1; return { a: 0.28 + 0.72 * t, r: 1.4 + 2.4 * t, t }; };
}

// ---------------------------------------------------------------- zoom, drag, pick
// The map state after zooming by k: in, past PPM_MAX, it stops; out, past PPM_MIN, it becomes the library view;
// from there any zoom in comes back to the wall, just above PPM_MIN, around you. Returns the fields that change.
export function zoomed(map, k) {
  if (map.log) return k > 1 ? { log: false, follow: true, ppm: PPM_MIN * 1.05 } : {};
  let ppm = map.ppm * k, log = false;
  if (ppm < PPM_MIN) log = true;
  ppm = Math.max(PPM_MIN, Math.min(PPM_MAX, ppm));
  return log ? { ppm, log } : { ppm };
}
// The centre after dragging from `drag` ({ x, y, cx, cz } where the drag began) to canvas point p.
export const dragged = (drag, p, ppm) => ({ cx: drag.cx - (p.x - drag.x) / ppm, cz: drag.cz + (p.y - drag.y) / ppm });
// The nearest hit within PICK_R2 of p (the first, on a tie), or null.
export function pick(hits, p) {
  let best = null, bd = PICK_R2;
  for (const h of hits || []) { const d = (h.x - p.x) ** 2 + (h.y - p.y) ** 2; if (d < bd) { bd = d; best = h; } }
  return best;
}
// "N m across" for the wall view's footer
export const across = (W, ppm) => ppm >= 1 ? Math.round(W / ppm) : Math.round(W / ppm / 100) * 100;

// ---------------------------------------------------------------- the wall
// The projection: metres (y along the gallery, z up) to canvas pixels, and back.
export function wallProjection(cx, cz, ppm, W, H) {
  return {
    cx, cz, ppm,
    X: y => W / 2 + (y - cx) * ppm, Z: z => H / 2 - (z - cz) * ppm,
    toY: x => cx + (x - W / 2) / ppm, toZ: y => cz - (y - H / 2) / ppm,
    y0: cx - W / 2 / ppm, y1: cx + W / 2 / ppm,   // metres along the gallery at the left and right edges
    fTop: Math.ceil((cz + H / 2 / ppm) / FLOOR_PITCH), fBot: Math.floor((cz - H / 2 / ppm) / FLOOR_PITCH) - 1,   // floors to draw
  };
}
const NICE = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

// Everything on the wall view: map { ppm, follow, cx, cz }; people from wallPeople; finds from sideFinds.
// While following, the view centres on you (cx, cz in the result: the page keeps them as its centre).
// Returns: rows (per floor: top and bottom of the shelves, the six shelf lines, the walkway's edge y, stair runs),
// dividers (x of each unit divider, and every how many metres), floor labels, metre labels, finds, people, hits.
export function wallScene(map, people, finds, W, H) {
  const ppm = map.ppm, me = people.find(p => p.me);
  let cx = map.cx, cz = map.cz;
  if (map.follow && me) { cx = me.y; cz = me.floor * FLOOR_PITCH + 1.2; }
  const pr = wallProjection(cx, cz, ppm, W, H), { X, Z, y0, y1, fTop, fBot } = pr;
  const step = ppm >= 4 ? 1 : ppm >= 1.5 ? 10 : 100;   // unit dividers: every metre, ten, or hundred
  const dividers = [];
  for (let u = Math.floor(y0 / step) * step; u <= y1; u += step) dividers.push(Math.round(X(u)) + .5);
  const rows = [];
  for (let f = fBot; f <= fTop; f++) {
    const base = f * FLOOR_PITCH, top = Z(base + UNIT_H), bot = Z(base);
    const shelves = [];
    if (ppm >= 2.5) for (let i = 0; i <= 6; i++) shelves.push(Math.round(Z(base + i * SHELF_PITCH)) + .5);
    const stairs = [];   // a 4.8 m flight beside the railing every 40 m, from this floor to the next: [x0, y0, x1, y1]
    if (ppm >= 1.5) for (let n = Math.floor((y0 - 15) / STAIR_PERIOD); n * STAIR_PERIOD + STAIR_OFF <= y1; n++) {
      const a = n * STAIR_PERIOD + STAIR_OFF; stairs.push([X(a), Z(base), X(a + STAIR_LEN), Z(base + FLOOR_PITCH)]);
    }
    rows.push({ floor: f, base, top, bot, edge: Math.round(bot) + .5, shelves, stairs });
  }
  // floor labels (as many as fit) and metres along the bottom
  const every = Math.max(1, Math.ceil(16 / (FLOOR_PITCH * ppm))), fe = NICE.find(v => v >= every) || every;
  const floorLabels = [];
  for (let f = Math.ceil(fBot / fe) * fe; f <= fTop; f += fe) {
    const y = Z(f * FLOOR_PITCH + 1.2); if (y < 10 || y > H - 24) continue;
    floorLabels.push({ floor: f, y, me: f === (me && me.floor) });
  }
  const me10 = NICE.find(v => v * ppm >= 70) || 10000, metreLabels = [];
  for (let v = Math.ceil(y0 / me10) * me10; v <= y1; v += me10) metreLabels.push({ metres: v, x: X(v) });
  // finds, then people (the ones off the view sit at its edge, pointing the way)
  const look = findLook(finds), fl = [];
  for (const f of finds) {
    const x = X(slotY(f.unit, f.slot)), y = Z(f.floor * FLOOR_PITCH + shelfZ(f.shelf) + 0.17);
    if (x < -6 || x > W + 6 || y < -6 || y > H + 6) continue;
    const k = look(f), d = { x, y, find: f, look: k, book: null };
    if (ppm >= SPINES_PPM)   // close enough to see books: the find's own spine lights up
      d.book = { x: X(f.unit + SLOT0 + f.slot * BOOK_W), y: Z(f.floor * FLOOR_PITCH + shelfZ(f.shelf) + BOOK_H), w: Math.max(2, BOOK_W * ppm), h: BOOK_H * ppm };
    fl.push(d);
  }
  const pl = [];
  for (const p of people) {
    let x = X(p.y), y = Z(p.floor * FLOOR_PITCH + 0.9); const off = x < 8 || x > W - 8 || y < 8 || y > H - 24;
    if (off && !p.me && !p.present) continue;
    x = Math.max(8, Math.min(W - 8, x)); y = Math.max(8, Math.min(H - 24, y));
    const right = x > W - 80;
    pl.push({ x, y, person: p, off, r: p.me ? 5 : 4, alpha: p.present || p.me ? 1 : 0.45,
      label: p.me || p.present ? `${off ? '→ ' : ''}${p.me ? 'you' : p.name}` : null, align: right ? 'right' : 'left', lx: x + (right ? -9 : 9) });
  }
  return { cx, cz, ppm, projection: pr, step, dividers, rows, floorLabels, metreLabels, finds: fl, people: pl,
    hits: [...fl.map(d => ({ x: d.x, y: d.y, find: d.find })), ...pl.map(d => ({ x: d.x, y: d.y, person: d.person }))] };
}
// Book spines, when ppm >= SPINES_PPM: 32 to a shelf, 6 shelves to a unit, each a fixed tone (0..7) and alpha.
// Calls paint(x, y, w, h, tone, alpha) for every book in one of the scene's rows, across the scene's metres.
export function eachSpine(scene, row, paint) {
  const { ppm, projection: { X, Z, y0, y1 } } = scene, bw = Math.max(0.5, BOOK_W * ppm - 0.4), { floor: f, base } = row;
  for (let u = Math.floor(y0); u <= y1; u++) for (let sh = 0; sh < 6; sh++) for (let sl = 0; sl < 32; sl++) {
      const h = ((u * 73856093) ^ (f * 19349663) ^ (sh * 83492791) ^ (sl * 2654435761)) >>> 0, drop = ((h >>> 6) & 3) * 0.02;
      paint(X(u + SLOT0 + sl * BOOK_W), Z(base + shelfZ(sh) + BOOK_H - drop), bw, (BOOK_H - drop) * ppm, h & 7, 0.55 + ((h >>> 3) & 7) / 20);
    }
}

// ---------------------------------------------------------------- the whole library
// Everyone and every find on symmetric-log scales. roster: every player (all sides: it sets the extent); people and
// finds: what to show (wallPeople, sideFinds); youId: whose farthest reach to mark.
export function libraryScene(roster, people, finds, W, H, youId) {
  const pad = 36;
  let ex = slog(1000), ef = slog(20);
  for (const p of roster) { ex = Math.max(ex, Math.abs(slog(p.y)), Math.abs(slog(p.farthestY))); ef = Math.max(ef, Math.abs(slog(p.floor)), Math.abs(slog(p.farthestFloor))); }
  for (const f of finds) { ex = Math.max(ex, Math.abs(slog(f.unit))); ef = Math.max(ef, Math.abs(slog(f.floor))); }
  ex *= 1.08; ef *= 1.12;
  const sx = v => W / 2 + slog(v) / ex * (W / 2 - pad), sy = v => H / 2 - slog(v) / ef * (H / 2 - pad);
  const rows = [];
  for (let f = -2000; f <= 2000; f++) {   // rows near home, where they are at least 3 px apart
    const a = sy(f + 0.75), b = sy(f); if (Math.abs(b - a) < 3 || b < pad / 2 || a > H - pad / 2) continue;
    rows.push({ floor: f, x: pad, y: a, w: W - pad * 1.5, h: b - a });
  }
  const tick = (k, s, unit) => (k ? s * 10 ** k : 0) === 0 ? '0' : (s < 0 ? '−' : '') + (10 ** k).toLocaleString() + unit;
  const xTicks = [], yTicks = [];
  for (let k = 0; 10 ** k < 10 ** (ex); k++) for (const s of k ? [-1, 1] : [1]) xTicks.push({ x: Math.round(sx(k ? s * 10 ** k : 0)) + .5, label: tick(k, s, ' m') });
  for (let k = 0; 10 ** k < 10 ** (ef); k++) for (const s of k ? [-1, 1] : [1]) yTicks.push({ y: Math.round(sy(k ? s * 10 ** k : 0)) + .5, label: tick(k, s, '') });
  const look = findLook(finds);
  const fl = finds.map(f => ({ x: sx(f.unit + 0.5), y: sy(f.floor), find: f, look: look(f) }));
  const pl = people.map(p => ({ x: sx(p.y), y: sy(p.floor), person: p, r: p.me ? 5 : 3.5, alpha: p.present || p.me ? 1 : 0.4, label: p.present || p.me ? (p.me ? 'you' : p.name) : null }));
  const you = roster.find(p => youId != null && p.id === youId);
  return { pad, ex, ef, sx, sy, rows, xTicks, yTicks, finds: fl, people: pl,
    reach: you ? { x: sx(you.farthestY), y: sy(you.farthestFloor) } : null,   // your farthest along each axis
    hits: [...fl.map(d => ({ x: d.x, y: d.y, find: d.find })), ...pl.map(d => ({ x: d.x, y: d.y, person: d.person }))] };
}

// ---------------------------------------------------------------- the board
// Each side has its own board; the other side's is the savages', and both together is the whole library's.
export const BOARD_TABS = ['ours', 'theirs', 'both'];
// What a tab lists, for someone on `side`: { side (null for both), list, min, empty (no board yet), rows }; each row
// { rank, find, mine (yours), savage (from the other side, on the both tab) }.
export function boardView(board, tab, side, youName) {
  const s = tab === 'ours' ? side : tab === 'theirs' ? side ^ 1 : null;
  const list = !board ? [] : s === null ? board.top : board.sides ? board.sides[s].top : board.top;
  const min = !board ? null : s === null ? board.min : board.sides ? board.sides[s].min : board.min;
  return { side: s, list, min, empty: !board,
    rows: list.map((f, i) => ({ rank: i + 1, find: f, mine: !!youName && f.finder === youName, savage: s === null && (f.side || 0) !== side })) };
}
