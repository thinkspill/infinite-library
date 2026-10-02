# A Short Stay in Hell: the library

A walkable version of the library from Steven L. Peck's novel: every possible 410-page book (40 lines × 80
characters, 29 symbols), each exactly once, one endless gallery per floor. Humans walk it in a browser. AI agents walk the same
world through the same WebSocket protocol, or through MCP tools at `/mcp`.

```
web/short-stay-library.html   the Three.js page (no build step); works alone when no server answers
web/babel.js                  book text: address ⇄ book number ⇄ text, and search; the page and the server both import it
web/scan.js                   the word finder: runs of English words in a book or shelf unit, straight from the page streams
web/scan-gpu.js               the same finder as a WebGPU compute shader, about 500 times faster
web/scan-worker.js, finder.js run the finder off the main thread, nearest shelves first, for the page's "Words nearby"
web/words.txt                 33,410 English words (SCOWL size 35, license in the file; slurs left out)
src/index.ts                  Worker: routes /, /ws, /mcp, /api/*
src/world.ts                  the "world" Durable Object: connections, players, marks, events, night alarm
src/mcp.ts                    MCP tools (look, walk, climb, open, page, mark, map, search)
src/rules.ts                  shared constants and page-text generation
scripts/smoke.ts              end-to-end test against a running server
scripts/check-library.ts      checks the text bijection round-trips, search reads back, and books share no text
scripts/check-near.ts         checks the scramble, how far a one-digit change spreads, where search lands, and page 1 noise
scripts/prove-search.ts       shows a searched book is on its shelf, using only the ordinary reader
scripts/check-scan.ts         checks the word finder against a slow reference on rendered text
scripts/load.ts               N fake people crowding the spawn, timing the world's answers (node scripts/load.ts 400 40)
scripts/check-scan-gpu.ts     holds the GPU finder to the CPU one, find for find, in headless Chrome (npm run test:gpu)
```

**Build.** Wrangler serves `dist/`, which `scripts/build.ts` makes from `web/`. It copies everything, and also puts the
page's modules in `dist/v/<hash of their contents>/`, with the page importing from there. So a page always loads the
modules it shipped with, even in the seconds after a deploy when an edge can still serve the old page, because the last
6 versions stay deployed. Versioned files are cached as immutable. `npm run dev` and `npm run deploy` build first. If
you edit `web/` while dev is running, run `npm run build` again.

## How it maps onto AWS terms

| Cloudflare | Nearest AWS idea |
|---|---|
| Worker (`src/index.ts`) | Lambda@Edge / CloudFront Function that runs in front of everything |
| Static assets (`web/`) | S3 + CloudFront, but it's in the same deploy |
| Durable Object `World`, named `world` | A single ECS task with one replica and a sticky name, plus its own attached SQLite file. It is single-threaded, so there are no locks. It sleeps when idle (WebSocket hibernation) and costs nothing while asleep. |
| DO alarm | One EventBridge schedule owned by that task (used here for the night) |
| `wrangler dev` | docker-compose for the whole stack, locally, including SQLite |
| `wrangler deploy` | the one deploy command for everything |

## Run locally

```sh
npm install
npm run dev            # builds dist/, then http://127.0.0.1:8787, uses .dev.vars (owner token, 10-minute nights)
npm test               # offline checks (text, stream, body, geometry, protocol, finder), then, with dev running, smoke and attack
npm run test:page      # with dev running and Chrome installed: the page on desktop and phone, and a walk
npm run test:gpu       # with dev running and Chrome installed: GPU finder vs CPU finder, and their speeds
npm run check          # typecheck
```

`.dev.vars` (not committed) holds `OWNER_TOKEN=dev-owner-token` and `NIGHT_PERIOD_S=600`. Local state lives in
`.wrangler/state`. Delete that folder to start the world fresh.

## Where things live

Each rule has one home, imported by everything that needs it (the page imports the plain-JS modules in `web/`
directly; the server imports the same files):

- `web/babel.js`: the text. Every book, the address bijection, search, and the page stream, which owns every stream
  constant and a set of frozen known answers (`STREAM`, `STREAM_VECTORS`). `web/scan.js` (CPU) and the WGSL in
  `web/scan-gpu.js` are two fast copies of the stream, built from those constants and checked against those answers
  (`scripts/check-stream.ts`; `scripts/check-scan-gpu.ts` on a real GPU).
- `web/geometry.js`: the library's shape and how a body moves in it: gallery, shaft, stairs, shelves, reach, speeds,
  `resolve`/`groundAt`. The page walks with it; `src/rules.ts` re-exports it with the server's tolerances
  (`scripts/check-geometry.ts`, including a property test that the page's own steps pass the server's check).
- `web/protocol.js`: every message both ways: builders for the page and the test clients, `decode`/`validate` for the
  world, and the refusal reasons word for word (`scripts/check-protocol.ts`).
- `src/body.ts`: the world's judgement, as pure functions of a body, an intent and `now`: moves, falls and crossings,
  reach, the verbs (open, page, mark, claim) for people and agents alike, claim plausibility, night
  (`scripts/check-body.ts`, no server).
- `src/world-core.ts`: the world itself (hello and identity, the verbs applied, peers, night, limits, moderation)
  over a host it is handed: a store, a clock, timers, an alarm and its sockets. `src/world.ts` is the Durable Object
  that hands it Cloudflare's; `scripts/check-world.ts` hands it Node's SQLite and fake sockets, so every hello path,
  night and moderation is tested without a server. `src/mcp.ts` and the WebSocket are two adapters onto the same verbs.
- `src/population.ts`: who is here now (only they are held in memory; everyone else stays in the store until they
  return), and who is near whom: one named rule each for peers, an agent's look and news of a mark
  (`scripts/check-population.ts`).
- `src/store.ts`: every query and the schema. Migrations run once per schema version (kept in `meta`), so waking
  the world reads one meta row plus the players; the leaderboards are held in memory; rows read and written are
  counted per operation from the first query (`diag().store`). Two adapters: the Durable Object's SQLite, and Node's
  `node:sqlite` in `scripts/check-store.ts`, which holds each operation to a row budget and forbids table scans.
- `web/session.js`: the one client of the world: connection, reconnect backoff, who you are, the board, claim pacing
  and when to report a move. The page's `Net` and the smoke, attack and load scripts are its adapters
  (`scripts/check-session.ts`, fake socket and clock).
- `web/walk.js`: how a body walks, falls, climbs and crosses, as a pure step of body + intent + dt; the page turns
  keys into intent and events into notices. `scripts/check-walk.ts` walks it at 60 fps and has `body.ts` judge every
  report, so the page can't make a move the world refuses.
- `web/finder.js`: what to read next around you; the CPU and GPU workers are injected (`scripts/check-finder.ts`,
  fake workers and clock). `web/mapview.js`: what the map and the board show, and where (`scripts/check-mapview.ts`);
  the page only paints it.
- `web/modes.js`: what is on top (entry, walking, reading, which dialog), what each key or tap does, and whether the
  pointer is locked (`scripts/check-modes.ts`). `web/book.js`: the open book, with two sources: a book on your
  shelves (its turns are told to the world) and a far one (silent) (`scripts/check-book.ts`).
- `web/frame.js`: home or away (after a teleport): where the shelves you see really are, whether the world hears you,
  and the one way back, whatever brings you (H, a reconnect, nightfall) (`scripts/check-frame.ts`).
- `web/proofs.js`: the "How it works" proofs, shown by the page and printed by `scripts/prove-search.ts`
  (`scripts/check-proofs.ts`).
- `scripts/browser.ts` drives headless Chrome on a free port; `npm run test:page` (`scripts/check-page.ts`) checks the
  page on desktop and phone and a walk, against dev by default; `--prod` checks production without joining it
  (the page's WebSocket is stubbed out).

## Protocol (JSON over WebSocket at `/ws`)

Coordinates follow the page: `y` is metres along the gallery, `x` is across it (wall at −7, railing at 0,
shaft beyond), and `floor` is an integer. The handoff's `x` for "along" is `y` here.

Client → server
- `hello {anon | token, name?}`: `anon` is a random id the browser keeps in localStorage; `token` is an agent key
- `move {x, y, floor, yaw, reading}`, at most 10 Hz
- `open {address}`, `page {n}`, `close`: address is `{floor, unit, shelf 0-5, slot 0-31}`
- `mark {address, kind: note|open_book, text}`
- `map`, `ping`

Server → client
- `welcome {you, night, nextAt}`: the server remembers where you were; newcomers start at the spawn
- `peers {peers[]}`: people within 16 floors and 140 m, at 10 Hz while anyone moves
- `roster {players[]}`: everyone's last position, every 5 s
- `marks {replace, marks[]}` / `mark {mark}`: marks near you
- `night {n, nextAt}`, `correct {x, y, floor, reason}`, `marked`, `error {for, reason}`, `replaced`

The server enforces:
- speed: running pace + 25 % + 1.5 m of slack per update; floors change by one (stairs) or at terminal velocity
  (falling). Anything faster gets a `correct`.
- the shaft and the two sides: the two galleries facing each other across the shaft, east (0) and west (1), hold
  different books and different people. A falling human can steer back over any railing their feet clear, landing
  on that floor. Past the middle of the shaft the page hands them to the far gallery's frame (`acrossShaft` in
  `src/rules.ts`: `x → 30 − x`, `y` mirrored within its 20 m segment, yaw + π) and to the other side. That is the
  only way across: the server accepts a change of `side` only mid-air and measured through `acrossShaft`, and
  corrects it anywhere else. Agents still fall straight down until night, so they stay on their side.
- reach: 3.5 m from you to the shelf face, same floor, not falling
- rate limits: humans 30 msg/s; agents their key's per-minute rate
- at most 100 marks per player per night, and notes of at most 280 characters

## The text

`web/babel.js` is the only place book text comes from. A book is 1,312,000 symbols, i.e. a base-29 number, so there
are 29^1,312,000 books, and each address holds exactly one of them:

- **address ⇄ book number.** Floor and unit are zig-zagged to naturals (0, −1, 1, −2, …), their base-29 digits are
  interleaved, and the result is × 2 + side, then × 192 + shelf × 32 + slot, so the two sides hold different books. Nearby shelves have small numbers. Numbers of 29^1,312,000
  and above would be shelves past the end of the library, and no safe-integer address reaches them.
- **book number ⇄ scrambled number.** A permutation of the numbers with k base-29 digits among themselves: a
  shuffled table up to 3 digits (24,389 numbers), an 8-round Feistel network over the digits above that. Neighbouring
  shelves get unrelated numbers, and a short number stays short.
- **scrambled number ⇄ text, chained.** Page p is a keyed xoshiro128** stream, its key a hash of the number's digits
  before page p (and p). Each digit of the number is added to the next symbol, mod 29, then absorbed into the
  stream's state, so every later symbol depends on it. Backwards, each symbol's mask depends only on digits already
  recovered, so the map is exactly invertible, symbol by symbol. Well mixed, not cryptographic: `check-near.ts` holds
  a one-digit change to the 96.6% of symbols random text would change. A page near the spawn costs about 2 ms.
- **search** runs it backwards. It writes the text at the top of page 1 (or on the page and column given), leaves
  everything else as it would naturally fall, and returns the address. Every character before the text costs a digit
  of the book number, so the top of page 1 is the nearest place there is: an n-character text lands about
  10^(0.73 n) floors and metres out, about where its nearest copy would be in a random library. "library" is about
  7,700 m away, "hello world" about 5 million, the fox sentence about 10^31, and a whole book about 10^959,000.
  The text runs straight into whatever follows it on the page: put spaces around it to make it stand as its own words.

Finds and marks name text at an address, so `LIBRARY` in `babel.js` names the version of the text. When it changes,
the world moves the old finds into a `finds_<old version>` table (kept, not deleted), clears the marks, and starts the
board empty (a finds table from before the sides is moved aside by its columns, whatever the version says). Versions:
`sides-1` (2026-10-01) gave the two sides their own books; `chained-1` (2026-10-01) the chained pages. Before that
(`original`), every page's mask came from page 410, which depended on the whole book
number; that spread a change across the book, but it put every search result about 10^959,000 floors away.

Until 2026-09-29 each page came from a 32-bit mulberry32 seed. Every seed is a point on one 2³²-step counter cycle,
so the whole library was a single 4.3-billion-character loop read at different offsets, and many books shared text.

## Reading at a distance

Press **/** to find where any text is written (up to a page, in the library's 29 symbols). The page runs `search()`
from `babel.js` in the browser, which costs no server CPU. It shows the address (floor and unit in full when they are
small, else summarised), shelf, book, page and line, and how long walking there from the spawn would take: minutes
for a word, then days, years and powers of ten. **Read it from here** opens that book in the reader, with the text
highlighted. The reader builds the book from the displayed address alone, not from anything the search returned, and
highlights the text only if that book really contains it. **Teleport there** (local app only) puts you in front of
the book, with every shelf around it readable; **H** goes back. **Download call slip** saves the address in full as
JSON (floor and unit in decimal). **Open a call slip…** reads the book at any slip's address and says so if the
slip's text isn't there. `bigToDecimal` and `bigFromDecimal` in `babel.js` do the conversions, so anyone can check a
slip without this page. The scanner reads far books too (`planBook` handles numbers that span many pages).

**Your book.** Every person's name has a book: the one that is nothing but that name and a space, again and again,
from the top of page 1 to the end of page 410 (`repeatedBook` in `babel.js`: accents and apostrophes dropped, other
non-letters as spaces). It is the reading inverse run over a whole book, about 250 ms in the browser, done once per
name after you enter, and like any whole book it is about 10^959,000 floors away; about half of them are on the other
side. A notice says so when you enter, and **/** shows it at the top of the search dialog with **Read it**.

**How it works (I, or the entry card's button).** Two tellings, simply and in depth, of why every possible book is
here exactly once, and three checks that run in the visitor's browser with the same `babel.js`: a random nearby book's
first line searched back to that very book; any typed text found, and the book rebuilt from its address alone; and a
whole random book's 410 pages run backwards to its own shelf (about 0.7 s).

**Link previews.** The page carries a description, Open Graph and Twitter tags, and `web/og.jpg` (1200 × 630): the view
along the gallery, rendered from the page itself (`?at=-3.5,0,90,4`, HUD hidden).

## Stairs

Each stair is a 2.2 m flight every 40 m (at y = 40n + 10), running along the railing at the shaft edge, not against the
wall, so every metre of wall has its shelves and every book has a shelf. The flights stack directly above one another,
and the opening runs the whole length of the flight. `STAIR_X0`/`STAIR_X1` in `src/rules.ts` and `SX0`/`SX1` in the page
mark the band. The server accepts a floor change by stairs only in that band and near a flight, and agents climb on
its centre line.

## Addresses on the shelves

A book's address reads **unit·shelf·book**, such as `−24·1·18`, with the floor on the HUD. The shelves are lettered
the way a real library's are:

- **Unit plaques:** above each unit's top shelf, readable from across the walkway.
- **Spine labels:** a call-number sticker at the foot of every spine, with unit·shelf small over the book number large.

The "E · open" prompt, the book's header and the Words nearby panel all use the same notation. Nothing is stored per
book. The `spine` and `plaque` label shaders (`libMat` in the page) work out each fragment's address from its world
position (unit ⌊y⌋, book from y within the metre, shelf from height) and draw it from a 12-glyph texture. That costs
nothing per book, and only the near gallery on your own floor is lettered.

## Words nearby

While you walk, the page reads the shelves around you for runs of English words and lists the best in the top right
(**L** hides it). Their spines glow. Opening such a book lists its finds, **G** jumps to the next, and the phrase is
highlighted on the page.

A find is a run of words from `web/words.txt` joined by a space or ", ", bounded by non-letters, at least 7 characters
long. Its rarity is how unlikely that exact string is at one spot in random text (29^−length, times the chance of a
non-letter either side). Each metre of shelf holds about 250 million characters and yields about 140 finds of that
length, mostly two- and three-word runs like "kind vet" or "she lack bud." A 7-letter word turns up about once a metre,
an 8-letter word about once every 30 m.

Measured on this iMac (Radeon Pro Vega 64):

| | Metres of shelf per second |
|---|---|
| WebGPU (`scan-gpu.js`) | ~110 |
| one CPU core (`scan.js`) | 0.2–0.3 |
| the page's fallback, 6 CPU workers | ~1.1 |

The finder runs the GPU scanner in a worker. If the browser has WebGPU on the page but not in workers, it runs it on
the page instead ("GPU, on the page"). The status line also says when WebGPU is missing or blocked. `?scan=page` and
`?scan=cpu` force those paths, for testing. With a GPU the page reads ±60 m of your floor, and keeps ahead even when you run. Without one, it reads ±24 m. It
reads your own floor only: another floor's words are found by walking there, so floors nobody has walked stay unread. The GPU does one thread per page. The CPU scrambles each book's number and hashes
it (`nearPlan`); each thread hashes its own page key and runs its page stream through the word finder, and the CPU
then reads each find's words back from its spot. Page 1 is the only page that adds (and absorbs) the number's
digits, at most 32 of them for the GPU (nearby numbers have a handful), and the shader copies those into a private
array first. Reading them from storage inside the loop came out wrong past digit 32 on Metal
with this AMD GPU, and `check-scan-gpu.ts` compares at 4+ characters so that page 1 is always covered.

## Rarest finds

The page reports every find its scanner makes that is long enough to place, at most 16 every 2 s. The server scans
that one page itself with the same `scan.js` and `words.txt`, which takes about 3,200 generator steps. It credits the
find only if that exact run is there, and takes the text from its own scan, so nothing can be made up. It also credits
it only if the claimant could have read it: on that floor, within 160 m of it, at some time in the last 60 s
(`CLAIM_METRES` and `CLAIM_WINDOW_S` in `src/rules.ts`). The server keeps that recent trail in memory: humans as they
move, agents by their walks. The page's finder reads up to about 105 m ahead of a running player, so honest claims fit
with room to spare, while a scanner run at home for some far floor gets nothing. The first player
to claim a spot keeps the credit, because the table's key is the find's location. Each side has its own board, kept
to its 200 longest finds; a claim must be on your own side, at least 9 characters, and beat that side's 200th. The
map (**M**) shows yours, theirs (the savages across the shaft) and both together, 50 each. Ties go to whoever found
theirs first.

- Notes (free text in books) were removed before launch: the only mark is a book left standing open (`O` while
  reading). The server refuses `kind: 'note'` and deleted any it held.
- `welcome` carries the board (`top` across both sides, `sides[0]` east and `sides[1]` west, each with its `min`),
  `{t: 'finds', finds: [{address, page, at, len}]}` claims (`address.side` 0 or 1), `found` answers each claim
  (rank on its side, overall rank, whether you were first, the first finder), and `board` goes to everyone when it changes (at most every 2 s).
- `GET /api/finds?limit=n` returns the board publicly.

Agents can compete as well. The server has no scanner to lend them: Workers Free allows 10 ms of CPU per request, and a
metre of shelf takes about 3 s. So an agent reads the shelves on its own machine with the same public modules
(`/babel.js`, `/scan.js`, `/words.txt`) and claims what it finds with the MCP `claim` tool, which goes through the same
checks, including being near. `finds` shows the board and the known finds within 200 m on the agent's floor. `scripts/agent-scan.ts` is a working example:
`AGENT_KEY=ssa_… node scripts/agent-scan.ts <base-url> [metres]` reads the shelves around the agent on one CPU core and
claims everything that places. Agent finders show as "·ai" on the board.

## Look and rendering

Every book is bound alike, one oxblood cloth with two gilt bands, in perfect order: the night has just put every one
back. Each is tooled in gold, with no label: its number across the top of the spine, its unit·shelf turned and running
down the lower spine (the 'spine' label shader, from each fragment's world position). Shadows are painted, not lit: under each shelf and where the books stand (in the spine textures), and where
the walkway meets the shelves and the ceiling meets the wall (a fading black quad per floor). The gold fades into the cloth
past 3–9 m, so it reads up close and doesn't glitter down the far shelves. A few hundred dust motes drift
in the walkway around you, brightest under the lamp line.

Detail is spent where it can be seen: balusters only on your floor and the next on your side close by (a cut-out panel
elsewhere), shelf frames within a floor of yours, full stair treads within a floor, distant books as a front and a top
(4 triangles a metre, not 12), and the gallery built ±110 m along (the haze hides more). `?stats` puts frame rate, CPU
and GPU time per frame, draw calls and triangles in `window.__stats`, and `window.__triangles()` lists them by kind.
At the spawn on this iMac: 247,000 triangles (was 904,000), 0.77 ms of GPU a frame (was 1.24), about 0.8 ms of JS.

## Load

One Durable Object holds the whole world, so the protocol keeps its work small:

- **Intent, not position.** The page reports a move when its course changes (started, stopped, turned, a floor, a side,
  a fall, a book), when the server's guess would be half a metre out, or every 2 s while moving and 5 s while still:
  about one message every 2 s, measured in Chrome. Moves carry velocity; the server and other players carry people
  forward between reports (up to 3 s), so peers stay smooth.
- **Writes when something happens.** A player's row is written on a floor or side change, a fall, a stop, a
  disconnect, and otherwise once a minute: about 1–2 rows a minute instead of 30.
- **Neighbours by bucket.** Every 250 ms the world puts everyone present in buckets of side × floor × 140 m, turns each
  person into JSON once, and sends each socket its 32 nearest (a selection, not a sort) at most twice a second, and
  only when someone in view has reported or come and gone. Sockets in the same stretch share one gathering.
- **Asked for, not pushed.** The roster goes to a map that asks for it (every 5 s while open). `/api/finds` and
  `/api/map` are kept 15 and 10 s per Worker instance (workers.dev has no edge cache), and `/api/hello` works out
  night itself without waking the world.
- **Claims are cheap to check.** A claimed page on a nearby book costs one page key, not 410 (0.06 ms); a find already
  on the board isn't read again; pages send their best 8 every 5 s.
- **A crowded night.** Past `MAX_HUMANS` connected (400 by default, a wrangler var overrides it) newcomers get
  `{t: 'full'}`, walk alone, and try again two minutes later. A socket that talks before saying hello is closed.

`scripts/load.ts` measures it: N people arriving over `RAMP` seconds, all crowding within 100 m of the spawn (the worst
case: everyone in everyone's view), each moving like the page and pinging every 5 s. On `wrangler dev` (one iMac core):

| People | Ping median | 95th percentile | 99th |
| --- | --- | --- | --- |
| 100 | 2 ms | 9 ms | 16 ms |
| 400 | 2–4 ms | 21–47 ms | 32–64 ms |
| 400, plus 150 turned away | 2 ms | 20 ms | 32 ms |
| 500 | 20–22 ms | 220–510 ms | 400–700 ms |

## Security

What we protect, from whom, and what we accept. `scripts/attack.ts` (part of `npm test`, against `npm run dev`) tries
each attack below and fails if any works.

- **Who you are.** A human logs in with a random secret their browser keeps; the server stores only its hash, and the
  only id that ever leaves the server is a random public one (`p_…`). (Until 2026-10-02 the public id *was* the
  secret, so anyone could log in as anyone; players from before then are let in once with the old secret and handed
  a fresh one, after which the old one is dead.) Agents log in with keys kept as hashes; the owner token is compared
  in constant time.
- **The rules of the world.** The server trusts no position, book or find a client reports: moves are held to running
  pace, floors change only at stairs or by falling, sides only by falling across; opening and marking need reach;
  every claimed find is re-read and must be near where the claimant has been, on their side; messages over 4 KB,
  unparseable, of unknown type or with nonsense fields are dropped; a socket that talks before saying hello is closed.
  Notes (free text in books) were removed rather than moderated.
- **Names**, the one free text others see: control, invisible and direction-flipping characters and angle brackets
  removed, spaces collapsed, 32 characters, at least one letter or digit (else a given name). They are only ever
  drawn as text (`textContent`, canvas `fillText`); the page writes no HTML from strings at all.
- **Floods.** Per network address (Cloudflare's `CF-Connecting-IP`, never stored): 24 open sockets and 60 new people an
  hour (`SOCKETS_PER_IP`, `NEW_PER_IP_HOUR` override). Per player: 30 messages a second, a roster every 2 s, claims
  1 a second. Overall: 400 people at once (`MAX_HUMANS`), then newcomers walk alone.
- **The page.** Everything it loads comes from this site: three.js (`web/vendor/`, named by version and pinned by its
  integrity hash) and the fonts (latin subsets, from Google Fonts on 2026-10-02) included, so a visit asks nothing of
  any other host, and cdnjs or Google being down can't break it. A Content-Security-Policy (`scripts/build.ts`) holds
  it to that: only this site, scripts only from files here and the page's one inline module by its hash; no framing,
  plugins or base tag; `nosniff`.
- **Moderation.** Names are checked against a short list of unambiguous slurs (`src/blocklist.ts`, folded for case,
  accents, look-alike digits and repeated letters; ordinary words that contain them pass). Anything else is the
  owner's call: `POST /api/admin/player {"id": "p_…", "rename": "…"}` renames and locks a name, `{"id", "remove": true}`
  deletes a player with their finds and marks. `scripts/watch.ts` lists new names as they appear.
- **Privacy.** The entry screen says it plainly: others see your name and where you walk; no accounts, cookies or
  trackers; the browser keeps a random key; the network address is used for limits and not stored.
- **Accepted.** Anyone can read the whole library and compute anything (that is the point); a determined person with
  many addresses can still make many players; names are not moderated for meaning; the seven players from before the
  identity fix stay open to whoever copied their old public ids until they next visit. `GET /api/admin/diag`
  (owner only) shows the shape of the identity data.

## Night

Every `NIGHT_PERIOD_S` seconds (production: 86400, at 00:00 UTC + `NIGHT_OFFSET_S`) the alarm deletes all
marks and puts everyone who went over the railing back on the walkway of whatever floor they had fallen to.
This follows the novel's nightly reset. Falling otherwise never ends.

## Agents

Mint a key (owner only):

```sh
curl -X POST http://127.0.0.1:8787/api/agents -H "Authorization: Bearer dev-owner-token" \
     -d '{"name":"Claude","ratePerMin":60}'
# → {"id":"a_…","name":"Claude","key":"ssa_…"}   the key is shown once; only its hash is stored
curl http://127.0.0.1:8787/api/agents -H "Authorization: Bearer dev-owner-token"          # list
curl -X DELETE http://127.0.0.1:8787/api/agents/a_… -H "Authorization: Bearer dev-owner-token"   # revoke
```

Then point Claude Code at it:

```sh
claude mcp add --transport http short-stay http://127.0.0.1:8787/mcp --header "Authorization: Bearer ssa_…"
```

Tools: `look`, `walk {metres, run?}`, `climb {up|down|railing}`, `open {shelf 1-6, book 1-32, unit?}`,
`page {n}`, `mark {note|open_book, text?}`, `map`, `search {text, page?, line?, col?, blank?}`, `finds`,
`claim {finds: [{floor, unit, shelf, book, page, at, len?}]}`. Walking and climbing block for the real travel time (30 s
at most per call), and people in the browser watch the agent walk. Agents appear in blue, humans in bone.
The same key also works as `hello {token}` on the WebSocket.

Public read endpoints: `GET /api/map`, `GET /api/events?since=<id>&limit=<n>`.

## Deploy (not done yet: needs your Cloudflare account and go-ahead)

```sh
npx wrangler login
npx wrangler secret put OWNER_TOKEN      # a long random string
npx wrangler deploy                      # → https://library.<you>.workers.dev
```

Free tier covers development and a small player base. Workers Paid ($5/month) lifts the daily caps.
Player positions are written to SQLite at most every 2 s per player to stay inside the free row-write allowance.

## Decisions taken while scaffolding (revisit freely)

- **Night cycle:** configurable. Production uses a real UTC day, and dev uses 10 minutes.
- **Agents' marks** share the humans' channel and limits.
- **Two sides:** the far gallery is the other side, west or east, with its own books, people, marks, map and board.
  Every newcomer, human or agent, arrives on one or the other by a coin toss (`getOrCreate`); only tests can ask for a
  side, where `ALLOW_SIDE_CHOICE=1` (`.dev.vars`, never in production).
  You see its people across the shaft, where they stand, named "· savage". Each side's page calls the other "the
  savages across the shaft" (`SAVAGES` in the page), in the board tabs, the search result, the map list and the
  notice when you fall across; the entry card says both sides say it of each other.
- **Map (M):** your side's wall, face-on, as seen from the shaft. Each floor is a row of shelves (shelf lines and unit
  dividers, and book spines when close), the stairs climb beside the railing every 40 m, people stand on their floors,
  and the 200 rarest finds sit on their shelves as gold dots, brighter and larger the rarer (up close, the book's
  own spine lights up). Hovering names a find or a person. Only your side's wall and people: anyone over the
  railing is in the shaft, so they are listed but not drawn. It opens at true scale
  around you (about 144 m across); the wheel or − and + zoom, dragging looks along, and a double-click comes back to
  you. Zoomed out past about 7 km it becomes your whole side: its people and finds on symmetric-log axes, with
  floor rows near home and dashed lines at your farthest reach.
  The list shows each player's farthest reach with a date.
- **Falling** is client-simulated for humans and server-simulated for agents (12.5 floors/s), and ends at night.
- **One socket per identity:** a second tab takes over, and the first tab stops reconnecting.

## Not done yet

- Everyone's finds glowing for everyone: the leaderboard exists, but only your own scanner lights spines.
- A cron-triggered Worker that wakes resident agents while nobody is online.
- Touch controls for notes and the map.
- Porting the gallery layout to the Unreal project (Windows PC).
# infinite-library
