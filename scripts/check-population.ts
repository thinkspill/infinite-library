// Checks src/population.ts, who is here and who is near whom, with no server: each nearness rule's floors, metres and
// whether it sees across the shaft; that a mark is told to people by where they are now (an agent mid-walk is where
// its walk has got to, not where it is going); the instant's index against a plain scan; and who is held.
// Run: node scripts/check-population.ts
import * as Pop from '../src/population.ts';
import type { Player, Person, Entry } from '../src/population.ts';
import * as B from '../src/body.ts';
import { acrossShaft, SHAFT } from '../web/geometry.js';

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; };
const T = Date.UTC(2026, 9, 2, 12);

console.log('The rules');
{
  const me = { side: 0, floor: 0, y: 100 };
  const at = (side: number, floor: number, y: number, x = -3.2) => ({ side, floor, y, x });
  // peers: 16 floors, 140 m
  check(Pop.isNear(Pop.PEERS, me, at(0, 16, 240)) && !Pop.isNear(Pop.PEERS, me, at(0, 17, 100)) && !Pop.isNear(Pop.PEERS, me, at(0, 0, 240.01)),
    'peers: 16 floors up or down and 140 m along, no further');
  // look: 2 floors, 60 m
  check(Pop.isNear(Pop.LOOK, me, at(0, -2, 40)) && !Pop.isNear(Pop.LOOK, me, at(0, 3, 100)) && !Pop.isNear(Pop.LOOK, me, at(0, 0, 160.5)),
    "an agent's look: 2 floors and 60 m");
  // across the shaft: where acrossShaft puts them on this side
  const there = at(1, 0, 100), seen = acrossShaft(there.x, there.y).y;
  check(Pop.seenAlong(Pop.PEERS, 0, there) === seen && Pop.isNear(Pop.PEERS, me, there) === Math.abs(seen - 100) <= 140,
    `peers see across the shaft, where acrossShaft puts them (y 100 over there is ${seen} here)`);
  check(Pop.seenAlong(Pop.LOOK, 0, there) === null && !Pop.isNear(Pop.LOOK, me, there) && Pop.isNear(Pop.LOOK, { ...me, side: 1 }, there),
    "an agent's look never sees across the shaft, but sees its own side");
  // a point near a segment end lands elsewhere across the shaft: the rule uses the mapped y, not the raw one
  const edge = at(1, 0, 239.9), mapped = acrossShaft(edge.x, edge.y).y;
  check(Pop.isNear(Pop.PEERS, me, edge) === Math.abs(mapped - 100) <= 140, `across the shaft, distance is to the mapped y (${edge.y} → ${mapped.toFixed(2)})`);
  check(!Pop.isNear(Pop.MARK_NEWS, me, there) && Pop.isNear(Pop.MARK_NEWS, me, at(0, 2, 240)) && !Pop.isNear(Pop.MARK_NEWS, me, at(0, 3, 100)),
    "a mark's news: its side only, 2 floors, 140 m");
  const s = Pop.marksStretch({ side: 1, floor: 3, y: 47 }), s2 = Pop.marksStretch({ side: 1, floor: 3, y: 59.9 }), s3 = Pop.marksStretch({ side: 1, floor: 3, y: 60 });
  check(s.key === s2.key && s.key !== s3.key && s.y === 50 && s.floors === 2 && s.metres === 140, 'marks are sent per 20 m stretch, from its middle, 2 floors and 140 m around');
  check(Pop.marksStretch({ side: 0, floor: 0, y: -0.5 }).y === -10, 'stretches below zero round down');
}

console.log('\nA mark is told by where people are now');
{
  // an agent walking from 256 back to 130 over 30 s: half way, it is at 193, though its stored y is already 130
  const agent: B.Body = { kind: 'agent', x: -3.2, y: 130, floor: 0, yaw: 0, side: 0, fall: null,
    legs: [{ t0: T, t1: T + 30_000, y0: 256, y1: 130, floor: 0, x: -3.2 }] };
  const mid = B.pos(agent, T + 15_000), mark = { side: 0, floor: 0, unit: 4 };
  check(Math.abs(mid.y - 193) < 1e-9, `half way, the agent is at ${mid.y}`);
  check(!Pop.hearsOfMark(mark, { side: 0, floor: mid.floor, y: mid.y }), 'a mark at unit 4 is 189 m from where it is: not told');
  check(Math.abs(agent.y - mark.unit) <= Pop.MARK_NEWS.metres, '(by its raw y, 126 m away, it would have been: the old bug)');
  const done = B.pos(agent, T + 30_000);
  check(Pop.hearsOfMark(mark, { side: 0, floor: done.floor, y: done.y }), 'arrived at 130, it is told');
  // a person carried forward: told by where they have got to
  const human: B.Body = { kind: 'human', x: -3, y: 0, floor: 0, yaw: 0, side: 0, fall: null, vx: 0, vy: 4, lastMoveAt: T };
  const later = B.pos(human, T + 3000);
  check(later.y === 12 && Pop.hearsOfMark({ side: 0, floor: 0, unit: 152 }, { side: 0, floor: 0, y: later.y }) && !Pop.hearsOfMark({ side: 0, floor: 0, unit: 152 }, { side: 0, floor: 0, y: human.y }),
    'a person running is told of a mark 140 m from where they have got to (12 m), not from their last report');
  check(!Pop.hearsOfMark(mark, { side: 1, floor: 0, y: 4 }), 'nobody across the shaft is told');
}

console.log('\nThe instant\'s index against a plain scan');
{
  const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const people: Entry[] = [];
  for (let i = 0; i < 3000; i++) {
    const side = rnd() < 0.5 ? 0 : 1, floor = Math.floor(rnd() * 41) - 20, y = (rnd() - 0.5) * 2000, x = rnd() < 0.1 ? rnd() * SHAFT : -rnd() * 6;
    const person: Person = { id: 'p' + i, kind: 'human', name: 'n', x, y, floor, side, yaw: 0, state: 'standing' };
    people.push({ id: person.id, ver: '0', json: '', person, side, floor, x, y });
  }
  const snap = new Pop.Snapshot(people);
  let badWithin = 0, badNearest = 0;
  for (let q = 0; q < 300; q++) {
    const v = { side: rnd() < 0.5 ? 0 : 1, floor: Math.floor(rnd() * 41) - 20, y: (rnd() - 0.5) * 2000 };
    for (const rule of [Pop.PEERS, Pop.LOOK, Pop.MARK_NEWS]) {
      const want = people.filter(e => e.id !== 'p0' && Pop.isNear(rule, v, e)).map(e => e.id).sort().join();
      const got = snap.within(rule, v, 'p0').map(e => e.id).sort().join();
      if (want !== got) badWithin++;
    }
    // nearest: the k with the smallest metres + 20 a floor, of those within PEERS
    const d = (e: Entry) => Math.abs((Pop.seenAlong(Pop.PEERS, v.side, e) as number) - v.y) + Pop.PEER_FLOOR_METRES * Math.abs(e.floor - v.floor);
    const all = people.filter(e => Pop.isNear(Pop.PEERS, v, e)).map(d).sort((a, b) => a - b);
    const got = snap.nearest(Pop.PEERS, v, Pop.MAX_PEERS).map(d).sort((a, b) => a - b);
    if (got.length !== Math.min(Pop.MAX_PEERS, all.length) || got.some((x, i) => Math.abs(x - all[i]) > 1e-9)) badNearest++;
  }
  check(badWithin === 0, `within(rule) agrees with a plain scan, 300 places × 3 rules over 3000 people (${badWithin} differ)`);
  check(badNearest === 0, `nearest(PEERS, 32) is the 32 nearest by metres + 20 a floor (${badNearest} differ)`);
}
{
  // launch day: everyone at the spawn, a few metres apart, a few on the stairs a floor up, some across the shaft
  const rnd = (() => { let s = 11; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const crowd: Entry[] = [];
  for (let i = 0; i < 400; i++) {
    const side = rnd() < 0.5 ? 0 : 1, floor = rnd() < 0.1 ? 1 : 0, y = 2 + rnd() * 6, x = -rnd() * 6;
    const person: Person = { id: 'c' + i, kind: 'human', name: 'n', x, y, floor, side, yaw: 0, state: 'standing' };
    crowd.push({ id: person.id, ver: '0', json: '', person, side, floor, x, y });
  }
  const snap = new Pop.Snapshot(crowd);
  let bad = 0, ordered = true;
  for (const me of crowd) {
    const v = { side: me.side, floor: me.floor, y: me.y };
    const d = (e: Entry) => Math.abs((Pop.seenAlong(Pop.PEERS, v.side, e) as number) - v.y) + Pop.PEER_FLOOR_METRES * Math.abs(e.floor - v.floor);
    const all = crowd.filter(e => e.id !== me.id && Pop.isNear(Pop.PEERS, v, e)).map(d).sort((a, b) => a - b);
    const near = snap.nearest(Pop.PEERS, v, Pop.MAX_PEERS, me.id);
    const got = near.map(d).sort((a, b) => a - b);
    if (near.some(e => e.id === me.id) || got.length !== Math.min(Pop.MAX_PEERS, all.length) || got.some((x, i) => Math.abs(x - all[i]) > 1e-9)) bad++;
    if (near.some((e, i) => i && near[i - 1].id > e.id)) ordered = false;
  }
  check(bad === 0, `in a crowd of 400 at the spawn, each sees their own 32 nearest, never themselves (${bad} differ)`);
  check(ordered, 'and in the same order for the same people (by id), so an unchanged view is not sent again');
}

console.log('\nWho is held');
{
  const mk = (id: string, o: Partial<Player> = {}): Player => ({ id, kind: 'human', name: id, pubId: 'p_' + id, secretHash: null, x: -3, y: 0, floor: 0, yaw: 0, side: 0,
    updatedAt: T, farthestY: 0, farthestFloor: 0, farthestAt: null, booksOpened: 0, connected: false, fall: null, ...o });
  const pop = new Pop.Population<Player>();
  const a = pop.adopt(mk('a', { connected: true })), again = pop.adopt(mk('a', { name: 'other' }));
  check(again === a && pop.size === 1 && pop.withPub('p_a') === a, 'adopting someone already held gives back the held one');
  pop.adopt(mk('idle', { kind: 'agent', updatedAt: T - Pop.AGENT_PRESENT_MS - 1 }));
  pop.adopt(mk('busy', { kind: 'agent', updatedAt: T - 1000 }));
  pop.adopt(mk('falling', { kind: 'agent', updatedAt: T - Pop.AGENT_PRESENT_MS - 1, fall: { t0: T - 5000, floor: 3 }, x: 1 }));
  pop.adopt(mk('walking', { kind: 'agent', updatedAt: T - Pop.AGENT_PRESENT_MS - 1, lastActAt: T - Pop.AGENT_PRESENT_MS - 1, legs: [{ t0: T - 1000, t1: T + 1000, y0: 0, y1: 3, floor: 0, x: -3.2 }] }));
  pop.adopt(mk('left'));
  pop.adopt(mk('claimer', { trail: [{ side: 0, floor: 0, lo: 0, hi: 5, t0: T - 30_000, t1: T - 20_000 }] }));
  check(pop.present(T).map(p => p.id).sort().join() === 'a,busy', 'present: a connected person, an agent that acted in the last 10 minutes');
  const gone = pop.sweep(T).map(p => p.id).sort().join();
  check(gone === 'idle,left' && pop.size === 5 && !pop.get('idle'), `sweep lets go of the idle agent and the person who left, keeps the falling, the walking and one whose trail could back a claim (${gone})`);
  check(pop.sweep(T + 41_000).map(p => p.id).sort().join() === 'claimer,walking', 'a minute after their trail ends they go too, as does the agent whose walk has ended');
  check(pop.anyInMotion(T) && pop.names().has('a'), 'someone is in motion; names are those held');
  const snap = pop.snapshot(T, p => ({ person: { id: p.pubId, kind: p.kind, name: p.name, x: p.x, y: p.y, floor: p.floor, side: p.side, yaw: 0, state: 'standing' }, ver: '0' }));
  check(snap.entries.map(e => e.id).sort().join() === 'p_a,p_busy', 'the snapshot holds only those present');
  pop.remove('a');
  check(!pop.get('a') && !pop.withPub('p_a') && !pop.isOnline('a'), 'removed, they are gone from every index');
}

console.log('\nWho is connected');
{
  const mk = (id: string, o: Partial<Player> = {}): Player => ({ id, kind: 'human', name: id, pubId: 'p_' + id, secretHash: null, x: -3, y: 0, floor: 0, yaw: 0, side: 0,
    updatedAt: T, farthestY: 0, farthestFloor: 0, farthestAt: null, booksOpened: 0, connected: false, fall: null, ...o });
  const pop = new Pop.Population<Player>();
  const h = pop.connect(mk('h')), bot = pop.connect(mk('bot', { kind: 'agent' }));
  check(h.connected && pop.get('h') === h && pop.isOnline('h') && pop.humansOnline === 1, 'connecting holds them, marks them connected, and counts a human');
  check(bot.connected && !pop.isOnline('bot') && pop.humansOnline === 1, 'an agent connects but is not counted toward the crowd');
  const tab = pop.connect(mk('h', { name: 'stale copy' }));
  check(tab === h && pop.humansOnline === 1, 'a second socket for someone held is the same person, counted once');
  check(pop.sweep(T + 3600_000).map(p => p.id).join() === '' && pop.get('h'), 'the connected are never swept, however long they stand');
  h.vx = 1; h.vy = 0.5; h.trail = [{ side: 0, floor: 0, lo: 0, hi: 5, t0: T - 30_000, t1: T - 1000 }];
  pop.disconnect(h);
  check(!h.connected && !h.vx && !h.vy && !pop.isOnline('h') && pop.humansOnline === 0 && pop.get('h') === h, 'disconnecting: not connected, still, not counted, but still held');
  check(pop.sweep(T).length === 0 && pop.get('h'), 'held while their trail could back a claim');
  check(pop.sweep(T + 60_000).map(p => p.id).join() === 'h' && !pop.isOnline('h'), 'and swept once it is a minute old');
  pop.connect(mk('h')); pop.connect(mk('k'));
  check(pop.humansOnline === 2, 'a returning person counts again');
  pop.remove('k');
  check(!pop.isOnline('k') && pop.humansOnline === 1, 'removing someone connected uncounts them');
  pop.clear();
  check(pop.size === 0 && pop.humansOnline === 0 && !pop.isOnline('h'), 'clearing lets go of everyone and everyone counted');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
