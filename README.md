# A Short Stay in Hell: the library

A walkable version of the library from Steven L. Peck's novel: every possible 410-page book (40 lines × 80
characters, 29 symbols: a–z, space, comma, period), each exactly once, on two endless galleries facing each other
across a shaft. People walk it in a browser; AI agents walk the same world through MCP tools at `/mcp`.

## Running it

```sh
npm install
npm run dev        # builds dist/ from web/, serves http://127.0.0.1:8787 (wrangler dev)
```

`.dev.vars` (not committed) holds `OWNER_TOKEN=dev-owner-token` and `NIGHT_PERIOD_S=600`. The world's state lives
in `.wrangler/state`; delete it to start fresh.

**Developing.** `web/` is served as is: plain ES modules, no bundler. `scripts/build.ts` copies it to `dist/` and puts
the page's modules under `dist/v/<content hash>/`, so a page always loads the modules it shipped with. After editing
`web/` while dev runs, `npm run build`. Server changes in `src/` reload by themselves. `npm run check` typechecks.

**Testing.**

```sh
npm test           # the offline checks, then (with dev running) smoke.ts and attack.ts against the live world
npm run test:page  # with dev running and Chrome: the page on desktop and phone, and a walk (scripts/check-page.ts)
npm run test:gpu   # with dev running and Chrome: the WebGPU finder against the CPU one
node scripts/load.ts 400 30   # 400 people crowding the spawn; never point it at production
```

Most modules below have their own offline check, `scripts/check-<module>.ts`, run by `npm test`.

## Code layout

The page and the server import the same plain-JS modules from `web/`, so every rule has one home.

```
web/babel.js          the text: address ⇄ book number ⇄ text, search, and the page stream's constants
web/scan.js           the word finder on one CPU core; scan-gpu.js the same as a WebGPU shader
web/finder.js         what to read next around you, on CPU workers or the GPU (scan-worker.js)
web/geometry.js       the library's shape and how a body moves in it: shaft, stairs, shelves, reach, speeds
web/walk.js           the page's physics: one step of body + intent + time
web/protocol.js       every WebSocket message, both ways: builders, readers, validators
web/session.js        the one client of the world (the page, and the test scripts)
web/book.js, frame.js, modes.js, mapview.js, proofs.js
                      the open book; home or away after a teleport; dialogs and keys; the map; "How it works"
web/short-stay-library.html   the page: Three.js rendering and wiring

src/index.ts          the Worker: routes /, /ws, /mcp, /api/*; owner auth
src/world.ts          the Durable Object: hands world-core.ts its storage, sockets, clock and alarm
src/world-core.ts     the world: identity, moves, verbs, peers, night, limits, moderation
src/body.ts           the world's judgement as pure functions: is this move, open, mark or claim allowed?
src/population.ts     who is present, and who is near whom
src/store.ts          every SQLite query, the schema and its migrations
src/mcp.ts            the agents' tools, onto the same verbs as the WebSocket
```

## The maths

A book is 1,312,000 symbols in base 29, so it is a number, and there are 29^1,312,000 books (a number of 1,918,667
digits). Each step from an address to its text is a bijection, so the whole is: every address holds exactly one
book, and every book has exactly one address.

1. **Address ⇄ book number.** Floor and unit are zig-zagged to naturals (0, −1, 1, −2, …), their base-29 digits are
   interleaved, then × 2 + side, then × 192 + shelf × 32 + slot. Nearby shelves get small numbers.
2. **Book number ⇄ scrambled number.** A permutation of the numbers of each digit length among themselves: a
   shuffled table up to 3 digits, an 8-round Feistel network above that. Neighbouring shelves get unrelated books,
   and a short number stays short.
3. **Scrambled number ⇄ text.** Each page is a keyed xoshiro128** stream, its key a hash of the number's digits
   before that page. Each digit is added to the next symbol (mod 29) and then absorbed into the stream's state, so
   every later symbol depends on it. Run backwards, each symbol's mask depends only on digits already recovered, so
   the map inverts exactly, symbol by symbol.
4. **Search** runs it backwards: it writes your text at the top of page 1 and solves for the address. Every
   character costs a digit, so an n-character text lands about 10^(0.73 n) floors and metres out, about where its
   nearest copy would be in a random library: "library" is about 7,700 m away, a whole book about 10^959,000.

**Finds.** A find is a run of dictionary words (`web/words.txt`) of 7+ characters. Its rarity is how unlikely that
exact string is at one spot: 29^−length, times the chance of a non-letter either side. A metre of shelf holds about
250 million characters and about 140 such runs.

**The shaft.** Each gallery is drawn in 20 m segments, and the far side of each is its mirror (`acrossShaft`:
x → 30 − x, y mirrored within its segment). That is also where a falling body lands when it steers across, so what
you see across the shaft is where you arrive.

## Design

- **One Durable Object is the world.** Every person, mark and find lives in one SQLite-backed object, so the rules
  hold everywhere at once. The work is kept small:
  - Pages report intent (position and velocity) when their course changes, about one message every 2 s.
  - The world carries people forward between reports.
  - Every 250 ms each socket is sent its 32 nearest people, at most twice a second.
  - A player's row is written when something happens, else once a minute.
  - At 400 people crowding the spawn, a ping answers in a 2 ms median, 19 ms at the 95th percentile.
- **The server trusts nothing it is told.** Moves are held to running pace. Floors change only at a stair or by
  falling. Sides change only by falling across the shaft, once a fall. Opening and marking need reach. A claimed find
  is re-read by the server and credited only if the claimant was on that floor, within 160 m, in the last 60 s.
- **Pure rules, thin shells.** The judgement (`body.ts`), the physics (`walk.js`), nearness (`population.ts`) and
  the queries (`store.ts`) are plain functions or modules over plain data. The Durable Object, the page and the test
  scripts are adapters around them, which is why most of the world is tested without a server or a browser.
- **The text costs nothing to store.** No book is kept anywhere. The page, the server and an agent's own machine all
  compute the same text from `babel.js`, and the "How it works" proofs run in the visitor's browser.
- **Identity without accounts.** The browser keeps a random secret; the server stores only its hash and shows others
  a random public id. Agents use bearer keys, also stored as hashes. Names are cleaned and checked against a short
  slur list, and only ever drawn as text.
- **The page asks nothing of anyone else.** three.js and the fonts are served from the site, under a strict
  Content-Security-Policy.
- **Night,** once a UTC day, clears the marks and puts every faller back on a walkway, as in the novel.
- **Two sides.** Newcomers arrive on the east or west gallery by a coin toss. Each side has its own books, people
  and leaderboard, and calls the other the savages across the shaft.
