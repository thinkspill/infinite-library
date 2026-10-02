// Checks web/frame.js, home or away, with no page: a teleport, and every way back (H, a welcome on reconnect, a
// correction at night), each told to the listeners once; the local → real address mapping; what the world hears.
// Run: node scripts/check-frame.ts
import { createFrame } from '../web/frame.js';
import { bigFromDecimal, bigToDecimal, bigEqual } from '../web/babel.js';

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; };
const HOME = { x: -3.2, y: 4, floor: 0, side: 0, yaw: Math.PI / 2, pitch: 0 };
const THERE = { x: 0.8, y: 2.5, floor: 0, side: 1, yaw: Math.PI, pitch: 0.1 };
const FAR = '123456789012345678901234567890';
const hit = { address: { floor: bigFromDecimal(FAR), unit: bigFromDecimal('98765432109876543210'), side: 1, shelf: 3, slot: 17 }, page: 1, line: 1, col: 1, query: 'hello world' };
const TP_UNIT = 2;
const watch = () => {
  const f = createFrame(), told: any[] = [];
  f.on(c => told.push(c));
  return { f, told };
};

console.log('Teleport');
{
  const { f, told } = watch();
  check(!f.away && !f.paused() && f.origin === null && f.home === null, 'starts home: not away, not paused, no origin');
  f.go({ hit, at: TP_UNIT, from: HOME, to: THERE });
  check(f.away && f.paused(), 'teleported: away, and the world hears nothing (paused)');
  check(f.origin && bigEqual(f.origin.floor, hit.address.floor) && bigToDecimal(f.origin.unit) === '98765432109876543208', `origin: the hit's floor, its unit less ${TP_UNIT} (${f.origin && bigToDecimal(f.origin.unit)})`);
  check(told.length === 1 && told[0].away && told[0].to === THERE && told[0].origin === f.origin, 'listeners told once: away, the origin, stand at the arrival pose');
  check(f.hit === hit, 'the hit that brought you is kept');
}

console.log('\nLocal and real addresses');
{
  const { f } = watch();
  const b = { floor: 0, unit: TP_UNIT, side: 1, shelf: 3, slot: 17 };
  check(f.real(b) === b, 'at home a local address is the real one (the same object)');
  f.go({ hit, at: TP_UNIT, from: HOME, to: THERE });
  const a = f.real(b);
  check(bigEqual(a.floor, hit.address.floor) && bigEqual(a.unit, hit.address.unit) && a.side === 1 && a.shelf === 3 && a.slot === 17, 'away, the book in front of you on arrival is the searched one');
  const n = f.real({ floor: -1, unit: TP_UNIT + 5, side: 1, shelf: 0, slot: 0 });
  check(bigToDecimal(n.floor) === '123456789012345678901234567889' && bigToDecimal(n.unit) === '98765432109876543215', `a floor down and 5 m on: ${bigToDecimal(n.floor)} / ${bigToDecimal(n.unit)}`);
  f.leave();
  check(f.real(b) === b, 'and home again, identity again');
}

console.log('\nH: home at the saved pose');
{
  const { f, told } = watch();
  f.go({ hit, at: TP_UNIT, from: HOME, to: THERE });
  f.go({ hit, at: TP_UNIT, from: THERE, to: THERE });   // a second teleport from away keeps the first home
  check(f.home && f.home.x === HOME.x && f.home.y === HOME.y && f.home.yaw === HOME.yaw, 'teleporting again from away keeps the first home');
  told.length = 0;
  const c = f.leave('home');
  check(!f.away && !f.paused() && f.origin === null && f.home === null, 'home: not away, not paused, no origin');
  check(told.length === 1 && !told[0].away && told[0].origin === null && told[0].to && told[0].to.x === HOME.x && told[0].to.y === HOME.y && told[0].to.floor === HOME.floor, 'listeners told once: stand at the saved pose, origin null');
  check(c === told[0], 'leave returns the change it told');
  check(f.leave('home') === null && told.length === 1, 'leaving twice is a no-op: nothing told, null returned');
}

for (const why of ['welcome', 'correct']) {
  console.log(`\nA ${why} while away: home where the world says`);
  const { f, told } = watch();
  f.go({ hit, at: TP_UNIT, from: HOME, to: THERE });
  told.length = 0;
  f.leave(why);
  check(!f.away && !f.paused() && f.origin === null && f.home === null, `after the ${why}: home, the saved pose discarded`);
  check(told.length === 1 && !told[0].away && told[0].origin === null && told[0].to === null && told[0].why === why, 'listeners told once: origin null, no pose (the world placed you)');
  f.leave(why); f.leave('home');
  check(told.length === 1, 'a second leave (another welcome, then H) is a no-op');
}

console.log('\nAt home, a welcome or a correction changes nothing');
{
  const { f, told } = watch();
  check(f.leave('welcome') === null && f.leave('correct') === null && told.length === 0 && !f.away, 'nothing told');
  const off = createFrame(); let n = 0; const stop = off.on(() => n++); stop();
  off.go({ hit, at: TP_UNIT, from: HOME, to: THERE }); off.leave();
  check(n === 0, 'a listener that stopped listening hears nothing');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
