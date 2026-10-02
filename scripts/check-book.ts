// Checks web/book.js, the open book: pages clamp to 1..410, G goes to the next find in order, an away book merges what
// the finder read with the search's own find, a far book never tells the world, a home book tells it open, page and
// close in protocol.js frames, and the text is babel.js's. No page, no server: node scripts/check-book.ts
import * as Book from '../web/book.js';
import * as Babel from '../web/babel.js';
import * as Proto from '../web/protocol.js';

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const A = { floor: 3, unit: -17, side: 1, shelf: 2, slot: 9 };
const finds = [{ page: 12, at: 5, len: 4, text: 'here' }, { page: 3, at: 100, len: 3, text: 'the' }, { page: 200, at: 0, len: 5, text: 'words' }];
const recorder = () => { const sent: unknown[] = []; return { sent, send: (m: unknown) => sent.push(m) }; };

console.log('Pages');
{
  const b = Book.home(A);
  check(b.page === 1, 'a book opens at page 1');
  check(b.turn(-1) === 1 && b.page === 1, 'page 1 back is still page 1');
  check(b.goTo(410) === 410 && b.turn(1) === 410, 'page 410 on is still page 410');
  check(b.goTo(0) === 1 && b.goTo(9999) === 410 && b.goTo(-5) === 1 && b.goTo(NaN) === 1, 'any page asked for is clamped to 1..410');
  check(b.goTo(57) === 57 && b.turn(1) === 58 && b.turn(-2) === 56, 'turning moves a page at a time');
  check(Book.far(A, { page: 999 }).page === 410, 'a far book opened past the end opens at 410');
}

console.log('\nFinds');
{
  const b = Book.home(A, { finds });
  check(same(b.finds.map(f => f.page), [3, 12, 200]), 'finds are held in page order');
  const seen = [b.nextFind(), b.nextFind(), b.nextFind(), b.nextFind()].map(f => f && f.page);
  check(same(seen, [3, 12, 200, 3]), `next find from page 1 goes 3, 12, 200, then back to 3 (${seen})`);
  b.goTo(13); check(b.nextFind()!.page === 200 && b.page === 200, 'from page 13 the next is on 200');
  check(Book.home(A).nextFind() === null, 'with no finds, there is no next find (and the page stays)');
  b.goTo(12); check(same(b.here().map(f => f.text), ['here']), 'here() is the finds on this page');
  const two = Book.home(A, { finds: [{ page: 4, at: 90, len: 2, text: 'b' }, { page: 4, at: 10, len: 2, text: 'a' }] }); two.goTo(4);
  check(same(two.here().map(f => f.text), ['a', 'b']), 'in reading order');
}

console.log('\nFar and away');
{
  // place a text with search, then open the far book at it: the text is there, and held as a find
  const r = Babel.search('hello world', {});
  const b = Book.far(r.address, { page: r.page, line: r.line, col: r.col, text: r.query });
  check(b.far && b.there === true && b.finds.length === 1 && b.finds[0].page === r.page && b.finds[0].len === r.query.length, 'a searched text is there, and is the book\'s one find');
  check(b.page === r.page && b.text().replace(/\n/g, '').slice(b.finds[0].at).startsWith('hello world'), 'the book opens at its page, the find marking it');
  check(Book.far(r.address, { page: r.page, line: r.line, col: r.col, text: 'goodbye world' }).there === false, 'a text that is not there is not (there: false), and makes no find');
  check(Book.far(r.address).there === null && Book.far(r.address).finds.length === 0, 'no text: there is null, no finds');
  // away: what the finder read on the shelves after a teleport, merged with the search's find (once, in page order)
  const at = b.finds[0].at, scanned = [{ page: 400, at: 7, len: 3, text: 'cat' }, { page: r.page, at, len: r.query.length, text: r.query }, { page: 1, at: 2, len: 3, text: 'dog' }];
  const away = Book.far(r.address, { page: r.page, line: r.line, col: r.col, text: r.query, finds: scanned });
  check(same(away.finds.map(f => f.page), [1, r.page, 400].sort((x, y) => x - y)) && away.finds.length === 3, 'away: scanned finds merge in, the duplicate of the search\'s own dropped, in page order');
  check(away.addFinds(scanned) === 0 && away.addFinds([{ page: 9, at: 1, len: 2, text: 'it' }]) === 1 && away.finds.length === 4, 'adding again adds only what is new');
  const neigh = Book.far({ ...r.address, slot: (r.address.slot + 1) % 32 }, { finds: scanned.slice(0, 1) });
  check(neigh.there === null && same(neigh.finds.map(f => f.page), [400]) && neigh.page === 1, 'a neighbour opened away: page 1, the finder\'s finds only');
  // silence: a far book tells nothing, whatever is done with it (it has no send at all)
  const { sent, send } = recorder();
  const quiet = Book.far(r.address, { finds: scanned, send } as never);
  quiet.open(); quiet.turn(1); quiet.goTo(300); quiet.nextFind(); quiet.close();
  check(sent.length === 0, 'a far book never tells the world (open, turn, go to, next find, close)');
}

console.log('\nWhat a home book tells the world');
{
  const { sent, send } = recorder();
  const b = Book.home(A, { finds, send });
  check(sent.length === 0, 'nothing on making it');
  check(b.open() === b && same(sent, [Proto.open(A)]), 'open: an open frame with its address');
  b.turn(1); b.turn(-1); b.turn(-1); b.goTo(12); b.nextFind();
  check(same(sent.slice(1), [Proto.page(2), Proto.page(1), Proto.page(1), Proto.page(12), Proto.page(200)]), 'each turn, go-to and next find: a page frame with the page now (at the ends too, as before)');
  b.close(); check(same(sent.at(-1), Proto.close()) && sent.length === 7, 'close: a close frame');
  const valid = sent.every(m => { const d = Proto.decode(Proto.encode(m as object)); return d.ok && Proto.validate(d.msg).ok; });
  check(valid && same(b.address(), Proto.address(A)), 'every frame is one the world accepts (decode, validate), and address() is Proto.address');
}

console.log('\nText');
{
  const b = Book.home(A);
  check(b.text() === Babel.pageText(A, 1) && b.text(77) === Babel.pageText(A, 77), 'a home book\'s text is babel.js pageText, page by page');
  b.goTo(410); check(b.text() === Babel.pageText(A, 410), 'and follows the page');
  const lines = b.text().split('\n');
  check(lines.length === Babel.LINES && lines.every(l => l.length === Babel.COLS), '40 lines of 80');
  const big = { floor: Babel.bigFromDecimal('1' + '0'.repeat(60)), unit: Babel.bigFromDecimal('-' + '9'.repeat(40)), side: 0, shelf: 5, slot: 31 };
  check(Book.far(big, { page: 33 }).text() === Babel.pageText(big, 33), 'a far book\'s text is the same babel.js text, for an address no one could walk to');
  check(Book.far(A).text(5) === Book.home(A).text(5), 'the two sources agree on the same address');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
