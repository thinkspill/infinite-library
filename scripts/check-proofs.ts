// Checks web/proofs.js, the proofs the page's "How it works" dialog runs and scripts/prove-search.ts prints, with no
// browser and no server: each proof holds for books near and far and for edge texts, a wrong claim is caught, and
// the highlight the page draws covers exactly the text that was found, across line breaks.
// Run: node scripts/check-proofs.ts
import { PAGES, COLS, ALPHABET } from '../web/babel.js';
import * as P from '../web/proofs.js';

let failures = 0, passed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (ok) passed++; else failures++; };
const flat = (s: string) => s.replace(/\n/g, '');
const proveAny = (t: string, o: object = {}): any => P.proveAny(t, o);   // its result is one of two shapes: a claim, or an error
let seed = 7; const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;   // repeatable
const randomText = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(rnd() * ALPHABET.length)]).join('');
// The highlight [from, to) in a rendered page is exactly the run: it reads as the query once the line breaks are
// taken out, and it neither starts nor ends on a line break.
const covers = (page: string, [from, to]: number[], query: string) => flat(page.slice(from, to)) === query && page[from] !== '\n' && page[to - 1] !== '\n'
  && flat(page.slice(0, from)).length + query.length === flat(page.slice(0, to)).length;

console.log('The highlight arithmetic');
{
  const eq = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
  check(eq(P.markRange(0, 1), [0, 1]) && eq(P.markRange(0, 80), [0, 80]), 'one line: no line break inside');
  check(eq(P.markRange(0, 81), [0, 82]) && eq(P.markRange(79, 2), [79, 82]), 'a run over a line end takes the line break with it');
  check(eq(P.markRange(80, 1), [81, 82]) && eq(P.markRange(3199, 1), [3238, 3239]), 'a run starting a line skips the break before it; the last character is at 3238');
  check(eq(P.markRange(0, 3200), [0, 3239]), 'the whole page is 3239 characters, 39 of them line breaks');
  // the formula the page used before proofs.js, for a run at the top of page 1: n lines shown, the mark ends at cut
  let same = true;
  const page = Array.from({ length: 40 }, () => randomText(COLS)).join('\n');
  for (const len of [1, 2, 79, 80, 81, 159, 160, 161, 240, 241, 1000, 3200]) {
    const n = Math.min(3, Math.ceil(len / 80) + 1), shown = page.split('\n').slice(0, n).join('\n'), cut = len + Math.floor((len - 1) / 80);
    const e = P.excerpt(page, 0, len);
    same &&= e.text === shown && e.from === 0 && shown.slice(0, cut) === e.text.slice(e.from, e.to) && shown.slice(cut) === e.text.slice(e.to);
  }
  check(same, 'for text at the top of page 1 the excerpt and highlight match what the page showed before');
  const e = P.excerpt(page, 150, 20);
  check(e.text === page.split('\n').slice(1, 4).join('\n') && covers(e.text, [e.from, e.to], flat(page).slice(150, 170)), 'mid-page across a line break: lines 2-4 shown (the run\u2019s two and one more), the run highlighted across the break');
}

console.log('\nA book you could walk to (address → book number → address; first line → search → same book)');
{
  const books = [{ floor: 0, unit: 0, side: 0, shelf: 0, slot: 0 }, { floor: 0, unit: 4, side: 0, shelf: 2, slot: 5 }, { floor: -5, unit: -200, side: 1, shelf: 5, slot: 31 },
    { floor: 5, unit: 200, side: 1, shelf: 0, slot: 17 }, ...Array.from({ length: 4 }, () => P.nearbyAddress(rnd))];
  for (const a of books) {
    const r = P.proveWalk(a);
    check(r.ok && r.roundTrip && r.steps.length === 3 && r.steps[1].text === r.line && r.line.length === COLS, `side ${a.side}, floor ${a.floor}, unit ${a.unit}, shelf ${a.shelf + 1}, book ${a.slot + 1}: holds (${r.number.length}-digit book number)`);
  }
  const nb = P.nearbyAddress(rnd);
  check([nb.floor >= -5 && nb.floor <= 5, nb.unit >= -200 && nb.unit <= 200, nb.side === 0 || nb.side === 1, nb.shelf >= 0 && nb.shelf < 6, nb.slot >= 0 && nb.slot < 32].every(Boolean), 'nearbyAddress stays within a walk of the spawn');
}

console.log('\nAny text: searched, then read back from the address alone');
{
  const texts: [string, string][] = [['a', 'one letter'], [' ', 'one space'], ['hello world', 'two words'], ['Hello World', 'capitals (searched as lowercase)'],
    ['well, well. yes... ,.,. ', 'punctuation and spaces'], ['line one\nline two', 'a line break (not a character)'], ['x'.repeat(80), 'exactly a line'],
    [randomText(81), '81 characters: over one line end'], [randomText(3200), '3200 characters: the whole page'], ['ian cook ian cook', 'a name']];
  for (const [t, what] of texts) {
    const r = proveAny(t), q = t.toLowerCase().replace(/\n/g, '');
    if (!r.claim) { check(false, `${what}: ${r.error}`); continue; }
    const pageStep = r.steps.find((s: any) => s.page);
    const shownOk = pageStep && pageStep.page.from === 0 && q.startsWith(flat(pageStep.page.text.slice(pageStep.page.from, pageStep.page.to)));
    check(r.ok && r.claim.query === q && covers(r.check.page, r.check.mark, q) && shownOk, `${what}: there, and the highlight covers exactly it`);
  }
  const big = proveAny(randomText(3200));
  check(big.ok && big.shown.text.split('\n').length === 3 && big.shown.to === big.shown.text.length, 'the whole page: three lines shown, all of them highlighted');
  for (const [opts, what] of [[{ page: 7, at: 150 }, 'page 7, character 150 (across a line end)'], [{ page: PAGES, at: 3200 - 11 }, 'the last characters of page 410'], [{ page: 3, at: 79, blank: true }, 'a blank page, at the end of line 1']] as const) {
    const r = proveAny('hello world', opts);
    check(r.ok && r.claim.page === opts.page && covers(r.check.page, r.check.mark, 'hello world') && covers(r.shown.text, [r.shown.from, r.shown.to], 'hello world'), `${what}: there, highlighted exactly`);
  }
  for (const [t, what] of [['', 'empty'], ['\n', 'only a line break'], ['x'.repeat(3201), '3201 characters'], ['hello!', 'a symbol not in the alphabet']]) {
    const r = proveAny(t);
    check(!r.ok && typeof r.error === 'string' && r.steps.length === 0, `${what}: refused (${r.error})`);
  }
}

console.log('\nA wrong claim fails');
{
  const r = proveAny('to be or not to be, that is the question.'), c = r.claim;
  check(P.verifyClaim(c).ok, 'the claim as search made it holds');
  check(!P.verifyClaim({ ...c, address: { ...c.address, slot: (c.address.slot + 1) % 32 } }).ok, 'the book next to it on the shelf: fails');
  check(!P.verifyClaim({ ...c, address: { ...c.address, side: 1 - c.address.side } }).ok, 'the same shelf across the shaft: fails');
  check(!P.verifyClaim({ ...c, col: 2 }).ok && !P.verifyClaim({ ...c, line: 2 }).ok && !P.verifyClaim({ ...c, page: 2 }).ok, 'one column, line or page off: fails');
  check(!P.verifyClaim({ ...c, query: 'to be or not to be, that is the questioN.'.toLowerCase().replace('question', 'questiom') }).ok, 'one letter of the text changed: fails');
  check(!P.verifyClaim({ ...c, query: '' }).ok, 'an empty claim proves nothing');
  const a = { floor: 1, unit: 2, side: 0, shelf: 3, slot: 4 }, b = { ...a, slot: 5 };
  const wrong = P.proveBook(a, P.readBook(b));
  check(!wrong.ok && P.sameShelf(wrong.back, b) && wrong.verdict.startsWith('✗'), 'a book’s pages offered as another’s lead back to their own shelf, not the claimed one');
  check(!P.sameShelf(a, b) && P.sameShelf(a, { ...a }) && P.sameShelf({ ...a, side: undefined }, { ...a, side: 0 }), 'sameShelf: slot matters; a missing side is the east side');
}

console.log('\nA whole book, both ways');
{
  for (const a of [{ floor: 0, unit: 3, side: 0, shelf: 2, slot: 5 }, { floor: -4, unit: 199, side: 1, shelf: 5, slot: 0 }, proveAny('far away').claim.address]) {
    const r = P.proveBook(a);
    check(r.ok && P.sameShelf(r.back, a), `side ${a.side}, shelf ${a.shelf + 1}, book ${a.slot + 1}: its 410 pages run backwards to the same shelf (${r.ms.toFixed(0)} ms)`);
  }
  const e = P.proveEdit({ floor: 0, unit: 3, side: 0, shelf: 2, slot: 5 });
  check(e.ok && !P.sameShelf(e.moved, e.address), 'one letter of page 200 changed: shelved somewhere else');
}

console.log('\nYour book: a name and nothing else');
{
  for (const name of ['Ian Cook', 'Soren', "Flann O'Brien", 'Zoë Renée', 'q']) {
    const r = P.proveName(name);
    check(r.ok && r.pagesGood === PAGES, `${JSON.stringify(name)} → "${r.name}": all ${PAGES} pages are it, and they lead back to its shelf`);
  }
  check(P.proveName("Flann O'Brien").name === 'flann obrien' && P.proveName('Zoë').name === 'zoe', 'the name as the library spells it: no apostrophes, no accents');
  const none = P.proveName('!!! ???');
  check(!none.ok && none.error, 'a name with nothing left to write: refused');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
