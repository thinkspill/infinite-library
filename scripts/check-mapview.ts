// Checks web/mapview.js, the map's and the board's maths, with no canvas: the wall's projection, zooming over to the
// log view and back, finds brighter the rarer, who is shown on the wall, and which finds each board tab lists.
// Run: node scripts/check-mapview.ts
import * as M from '../web/mapview.js';
import { rarity } from '../web/scan.js';
import { FLOOR_PITCH, slotY, shelfZ } from '../web/geometry.js';

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; };
const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) <= e;
const W = 900, H = 500;
type Find = { floor: number; unit: number; side?: number; shelf: number; slot: number; page: number; len: number; words: number; text: string; finder: string };
const find = (o: Partial<Find>): Find => ({ floor: 0, unit: 0, side: 0, shelf: 2, slot: 5, page: 1, len: 10, words: 2, text: 'x', finder: 'ann', ...o });

console.log('Rarity');
{
  const fs = [7, 12, 40, 3000].map(len => find({ len }));
  check(fs.every(f => near(rarity(f), f.len * Math.log10(29) + 2 * Math.log10(29 / 3))), 'scan.js rarity: "1 in 10^r", r = len·log 29 + 2·log(29/3), the copy the page had');
}

console.log('\nThe wall: projection');
{
  const pr = M.wallProjection(120.5, 7.3, 5, W, H);
  check(near(pr.X(120.5), W / 2) && near(pr.Z(7.3), H / 2), 'the centre is mid-canvas');
  const ok = [-300, 0, 37.25, 120.5, 9999].every(y => near(pr.toY(pr.X(y)), y, 1e-6)) && [-50, 0, 7.3, 300].every(z => near(pr.toZ(pr.Z(z)), z, 1e-6));
  check(ok, 'metres → pixels → metres round-trips, along and up');
  const xs = [-10, -1, 0, 1, 10, 100].map(pr.X), zs = [-10, -1, 0, 1, 10, 100].map(pr.Z);
  check(xs.every((x, i) => !i || x > xs[i - 1]) && zs.every((z, i) => !i || z < zs[i - 1]), 'further along is further right; higher is further up');
  check(near(pr.X(pr.y0), 0) && near(pr.X(pr.y1), W), 'y0 and y1 are the left and right edges');
  check(pr.Z(pr.fBot * FLOOR_PITCH) >= H && pr.Z((pr.fTop + 1) * FLOOR_PITCH) <= 0, 'the floors drawn cover the canvas, top to bottom');
}

console.log('\nThe wall: scene');
{
  const people = M.wallPeople([], { x: -2, y: 1234.6, floor: -3, side: 0 }, 'me');
  const s = M.wallScene({ ppm: 5, follow: true, cx: 0, cz: 0 }, people, [], W, H);
  check(s.cx === 1234.6 && near(s.cz, -3 * FLOOR_PITCH + 1.2), 'following, the view centres on you');
  check(near(s.people[0].x, W / 2) && s.people[0].label === 'you' && s.people[0].r === 5, 'and you are in the middle, labelled');
  const still = M.wallScene({ ppm: 5, follow: false, cx: 50, cz: 3 }, people, [], W, H);
  check(still.cx === 50 && still.cz === 3, 'not following, the centre stays where it was dragged');
  check(still.people.length === 1 && still.people[0].off && still.people[0].x === W - 8 && still.people[0].label === '→ you', 'and you, off the view, sit at its edge pointing the way');
  const d = M.dragged({ x: 100, y: 100, cx: 50, cz: 3 }, { x: 150, y: 80 }, 5);
  check(near(d.cx, 40) && near(d.cz, -1), `dragging right by 50 px at 5 px/m looks 10 m back along (${d.cx}, ${d.cz})`);
  check(s.dividers.length > 0 && s.step === 1 && M.wallScene({ ppm: 2, follow: false, cx: 0, cz: 0 }, [], [], W, H).step === 10 && M.wallScene({ ppm: 1, follow: false, cx: 0, cz: 0 }, [], [], W, H).step === 100, 'unit dividers every metre, ten or hundred as you zoom out');
  check(s.rows.every(r => r.shelves.length === 7) && M.wallScene({ ppm: 2, follow: false, cx: 0, cz: 0 }, [], [], W, H).rows.every(r => !r.shelves.length), 'shelf lines only from 2.5 px/m');
  const stairs = M.wallScene({ ppm: 5, follow: false, cx: 0, cz: 1.2 }, [], [], W, H).rows.find(r => r.floor === 0)!.stairs;
  check(stairs.some(([x0, , x1]) => near(x0, W / 2 + 10 * 5) && near(x1, W / 2 + 14.8 * 5)), 'a stair from 10 m to 14.8 m along');
  const f = find({ unit: 3, slot: 7, shelf: 1, floor: 0 }), sc = M.wallScene({ ppm: 5, follow: false, cx: 0, cz: 1.2 }, [], [f], W, H);
  check(sc.finds.length === 1 && near(sc.finds[0].x, W / 2 + slotY(3, 7) * 5) && near(sc.finds[0].y, H / 2 - (shelfZ(1) + 0.17 - 1.2) * 5) && !sc.finds[0].book, 'a find sits on its book, as a dot when far');
  const close = M.wallScene({ ppm: 20, follow: false, cx: 3, cz: 1.2 }, [], [f], W, H);
  check(close.finds[0].book && close.finds[0].book.h === 0.3 * 20, 'close up, its own spine lights up');
  check(sc.hits.length === 1 && sc.hits[0].find === f, 'and it can be pointed at');
  const offView = M.wallScene({ ppm: 5, follow: false, cx: 0, cz: 1.2 }, [], [find({ unit: 5000 })], W, H);
  check(offView.finds.length === 0, 'a find off the view is left out');
  check(M.pick([{ x: 10, y: 10 }, { x: 14, y: 10 }], { x: 13, y: 10 })?.x === 14 && M.pick([{ x: 10, y: 10 }], { x: 30, y: 10 }) === null, 'pointing picks the nearest within 9 px, or nothing');
  check(M.across(900, 5) === 180 && M.across(900, 0.5) === 1800, 'the footer says how many metres across');
}

console.log('\nWho is on the wall');
{
  const roster = [
    { id: 'a', name: 'ann', side: 0, x: -3, y: 10, floor: 0, present: true },
    { id: 'b', name: 'bo', side: 1, x: -3, y: 12, floor: 0, present: true },        // across the shaft
    { id: 'c', name: 'cy', x: 4, y: 14, floor: 0, present: true },                  // in the shaft
    { id: 'me', name: 'me', side: 0, x: -2, y: 0, floor: 0, present: true },        // the roster's you
    { id: 'd', name: 'di', x: -1, y: 20, floor: 1 },                                // no side: east
  ];
  const east = M.wallPeople(roster, { x: -2, y: 0.5, floor: 0, side: 0 }, 'me');
  check(east.map(p => p.name).join() === 'ann,di,you', `east: ann, di and you (${east.map(p => p.name)})`);
  check(!east.some(p => p.name === 'bo'), 'people on the other side are not on your wall');
  check(!east.some(p => p.name === 'cy'), 'nor anyone in the shaft');
  const west = M.wallPeople(roster, { x: -2, y: 0.5, floor: 0, side: 1 }, 'me');
  check(west.map(p => p.name).join() === 'bo,you', 'from the west, bo and you');
  check(M.wallPeople(roster, { x: 3, y: 0, floor: 0, side: 0 }, 'me').every(p => !p.me), 'you, over the railing, are not on the wall either');
  const fs = [find({ side: 0 }), find({ side: 1 }), find({})];
  delete fs[2].side;
  check(M.sideFinds(fs, 0).length === 2 && M.sideFinds(fs, 1).length === 1, 'finds: your side only (no side is east)');
  const away = M.wallScene({ ppm: 5, follow: true, cx: 0, cz: 0 }, [{ name: 'eve', y: 9999, floor: 0, present: false }, { name: 'fay', y: 9999, floor: 0, present: true }, { me: true, name: 'you', y: 0, floor: 0, present: true }], [], W, H);
  check(away.people.map(p => p.person.name).join() === 'fay,you', 'off the view: those present are kept at the edge, those away dropped');
}

console.log('\nFinds: brighter the rarer');
{
  const fs = [9, 30, 14, 60, 7].map(len => find({ len }));
  const look = M.findLook(fs), ls = fs.map(look);
  const byR = fs.map((f, i) => [rarity(f), ls[i]] as const).sort((a, b) => a[0] - b[0]);
  check(byR.every(([, l], i) => !i || (l.a > byR[i - 1][1].a && l.r > byR[i - 1][1].r)), 'brightness and size rise with rarity');
  check(near(byR[0][1].a, 0.28) && near(byR[byR.length - 1][1].a, 1), 'the commonest at 0.28, the rarest at full brightness');
  check(near(M.findLook([find({})])(find({})).a, 1), 'a lone find is at full brightness');
  const sc = M.wallScene({ ppm: 5, follow: false, cx: 0, cz: 1.2 }, [], fs, W, H);
  check(sc.finds.every((d, i) => near(d.look.a, ls[i].a)), 'the wall scene uses the same looks');
}

console.log('\nZoom');
{
  let m = { ppm: M.MAP_PPM, log: false, follow: true };
  m = { ...m, ...M.zoomed(m, 1.6) };
  check(near(m.ppm, 8) && !m.log, 'in: 1.6× the pixels a metre');
  for (let i = 0; i < 20; i++) m = { ...m, ...M.zoomed(m, 1.6) };
  check(m.ppm === M.PPM_MAX, 'and no further than PPM_MAX');
  m = { ppm: 0.12, log: false, follow: false };
  m = { ...m, ...M.zoomed(m, 1.1) };
  check(!m.log && near(m.ppm, 0.132), 'just above the threshold, still the wall');
  m = { ...m, ...M.zoomed(m, 1 / 1.6) };
  check(m.log && m.ppm === M.PPM_MIN, `past PPM_MIN (${M.PPM_MIN}): the log view`);
  const same = M.zoomed(m, 1 / 1.6);
  check(!Object.keys(same).length, 'zooming out further changes nothing');
  m = { ...m, ...M.zoomed(m, 1.18) };
  check(!m.log && m.follow && near(m.ppm, M.PPM_MIN * 1.05), 'any zoom in comes back to the wall, around you, just above PPM_MIN');
}

console.log('\nThe whole library: log scales');
{
  check(M.slog(0) === 0 && near(M.slog(9), 1) && near(M.slog(-99), -2), 'slog: 0 → 0, 9 → 1, −99 → −2');
  const xs = [-1e6, -1000, -10, -1, 0, 1, 10, 1000, 1e6].map(M.slog);
  check(xs.every((x, i) => !i || x > xs[i - 1]), 'slog is monotonic');
  const roster = [{ id: 'me', y: 50, floor: 2, farthestY: 30000, farthestFloor: -40 }, { id: 'x', y: -5, floor: 0, farthestY: 1, farthestFloor: 0 }];
  const people = [{ me: true, y: 50, floor: 2, present: true, name: 'you' }, { name: 'z', y: -200, floor: 1, present: false }];
  const s = M.libraryScene(roster, people, [find({ unit: 7, floor: 3 })], W, H, 'me');
  check(near(s.sx(0), W / 2) && near(s.sy(0), H / 2), 'home is mid-canvas');
  check(s.sx(1e4) < s.sx(3e4) && s.sx(3e4) <= W - s.pad && s.sx(-3e4) >= s.pad, 'the farthest anyone has been fits, inside the padding');
  check(s.xTicks.some(t => t.label === '10,000 m') && s.xTicks.some(t => t.label === '−10,000 m') && s.xTicks.some(t => t.label === '0'), 'decades along the bottom, both ways');
  check(s.reach && near(s.reach.x, s.sx(30000)) && near(s.reach.y, s.sy(-40)), 'your farthest reach is marked');
  check(s.people[1].alpha === 0.4 && s.people[1].label === null && s.people[0].label === 'you', 'those away are faint and unlabelled');
  check(s.rows.every(r => r.h >= 3), 'floors are drawn as rows only where at least 3 px apart');
  check(s.hits.length === 3 && s.hits[0].find, 'finds, then people, can be pointed at');
}

console.log('\nThe board');
{
  const e = [find({ text: 'east one', finder: 'me' }), find({ text: 'east two' })], w = [find({ text: 'west', side: 1 })];
  const board = { sides: [{ top: e, min: 9 }, { top: w, min: 8 }], top: [w[0], ...e], min: 8 };
  const ours = M.boardView(board, 'ours', 0, 'me');
  check(ours.side === 0 && ours.list === e && ours.min === 9, 'ours: this side\'s finds and minimum');
  check(ours.rows[0].rank === 1 && ours.rows[0].mine && !ours.rows[1].mine, 'ranked, yours marked');
  const theirs = M.boardView(board, 'theirs', 0, 'me');
  check(theirs.side === 1 && theirs.list === w && theirs.min === 8 && !theirs.rows[0].savage, "theirs: the savages' side");
  check(M.boardView(board, 'theirs', 1, 'me').list === e, 'from the west, theirs is the east');
  const both = M.boardView(board, 'both', 0, 'me');
  check(both.side === null && both.list === board.top && both.rows[0].savage && !both.rows[1].savage, 'both: the whole board, the other side marked savage');
  const none = M.boardView(null, 'ours', 0, 'me');
  check(none.empty && none.rows.length === 0 && none.min === null, 'no board yet: nothing');
  check(M.BOARD_TABS.join() === 'ours,theirs,both', 'three tabs');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
