// /mcp: the same world, exposed as MCP tools so Claude Code (or any MCP client) can walk the library.
// Stateless Streamable HTTP; each request carries the agent's key as a bearer token.
import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { World } from './world';
import * as Babel from '../web/babel.js';
import * as R from './rules';
import type { AgentClaim } from './body';

const HOW_TO = `You are in the library from Steven L. Peck's "A Short Stay in Hell": every possible 410-page book
(40 lines × 80 characters, 29 symbols a–z, space, comma, period), each exactly once, shelved along one endless
gallery per floor. There are two such galleries, east and west, facing each other across a 30 m shaft, each with its
own books and its own people; you arrived on one of them (look says which), and only by falling across the shaft could anyone change sides.
Nobody on either side thinks much of the savages across the shaft. search tells you the nearest shelf whose book opens
with a text: a word may be a short walk away, a sentence is unimaginably far, though you have time. The rarest runs of
real English on the shelves go on each side's leaderboard (finds), credited to whoever claims them first (claim).
Each metre of wall is one shelf unit: 6 shelves × 32 books. Floors are 3.2 m apart and all identical; stairs every
40 m connect each floor to the next. You move at human pace:
walking 1.5 m/s, running 4.2 m/s; tools block until you arrive (at most 30 s per call). Marks you leave vanish at night.
Going over the railing means falling until night.`;

type Stub = DurableObjectStub<World>;

export async function handleMcp(req: Request, env: Env, ctx: ExecutionContext, world: Stub): Promise<Response> {
  const key = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const agent = key ? await world.authAgent(key) : null;
  if (!agent) {
    return new Response(JSON.stringify({ error: 'missing or invalid agent key; mint one with POST /api/agents' }), {
      status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="short-stay"' } });
  }
  return createMcpHandler(() => buildServer(world, agent.id, agent.name), { route: '/mcp' })(req, env, ctx);
}

function buildServer(world: Stub, id: string, name: string) {
  const server = new McpServer({ name: 'short-stay-library', version: '0.1.0' }, { instructions: HOW_TO });
  const ok = (data: unknown, lead?: string) => ({ content: [{ type: 'text' as const, text: (lead ? lead + '\n\n' : '') + JSON.stringify(data, null, 2) }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });
  const wrap = <A,>(fn: (a: A) => Promise<ReturnType<typeof ok>>) => async (a: A) => { try { return await fn(a); } catch (e) { return fail(e); } };
  // +250 ms: the world object's clock can trail this Worker's by a few ms, and arriving early reads as still on the way
  const waitUntil = (t: number) => new Promise(r => setTimeout(r, Math.max(0, Math.min(35_000, t + 250 - Date.now()))));

  server.registerTool('look', {
    description: `Where you are (${name}), what is in front of you, the nearest stairs, other people nearby, marks on nearby books, and time to night.`,
    inputSchema: z.object({}),
  }, wrap(async () => ok(await world.agentLook(id))));

  server.registerTool('walk', {
    description: 'Walk along the gallery. Positive metres toward higher unit numbers, negative toward lower. Blocks until you arrive; capped at 30 s of travel per call.',
    inputSchema: z.object({ metres: z.number().describe('signed distance along the gallery'), run: z.boolean().optional().describe('hurry at 4.2 m/s instead of 1.5') }),
  }, wrap(async ({ metres, run }: { metres: number; run?: boolean }) => {
    const r = await world.agentWalk(id, metres, !!run);
    await waitUntil(r.arriveAt);
    return ok(await world.agentLook(id, true), r.truncated ? `You could only cover ${r.metres} m in one go.` : `You walked ${r.metres} m.`);
  }));

  server.registerTool('climb', {
    description: '"up" or "down": walk to the nearest stair and take it to the next floor. "railing": climb over the railing into the shaft and fall until night.',
    inputSchema: z.object({ where: z.enum(['up', 'down', 'railing']) }),
  }, wrap(async ({ where }: { where: 'up' | 'down' | 'railing' }) => {
    const r = await world.agentClimb(id, where);
    await waitUntil(r.arriveAt);
    return ok(await world.agentLook(id, true));
  }));

  server.registerTool('open', {
    description: 'Take a book down from the shelf unit in front of you (or a unit within reach) and read page 1.',
    inputSchema: z.object({
      shelf: z.number().int().min(1).max(6).describe('1 is the bottom shelf'),
      book: z.number().int().min(1).max(32).describe('position on the shelf, 1 at the lower-unit end'),
      unit: z.number().int().optional().describe('unit number; defaults to the one you stand at'),
    }),
  }, wrap(async ({ shelf, book, unit }: { shelf: number; book: number; unit?: number }) => ok(await world.agentOpen(id, shelf, book, unit))));

  server.registerTool('page', {
    description: 'Turn to page n (1-410) of the book you are holding.',
    inputSchema: z.object({ n: z.number().int().min(1).max(410) }),
  }, wrap(async ({ n }: { n: number }) => ok(await world.agentPage(id, n))));

  server.registerTool('mark', {
    description: 'Leave the book you are holding standing open, for others on your side to come across. Marks vanish at night.',
    inputSchema: z.object({ kind: z.enum(['open_book']).optional().describe('the only kind there is') }),
  }, wrap(async () => ok(await world.agentMark(id, 'open_book'), 'You leave it standing open.')));

  server.registerTool('search', {
    description: 'Find the shelf where a text is written: any 1-3200 characters of a-z, space, comma and period (a line break is the end of '
      + 'a page line, not a character, so text copied from a page searches as it stands there). Every text is somewhere, once for '
      + 'every place it could sit; by default this finds the nearest book that opens with it (page 1, line 1), about 10^(0.73 × length) '
      + 'floors and metres away: a short word can be a walk away, a sentence is astronomically far. Large floors and units come back '
      + 'as sizes with leading and final digits. Nothing moves you there.',
    inputSchema: z.object({
      text: z.string().min(1).max(3300).describe('1-3200 characters once line breaks are taken out'),
      page: z.number().int().min(1).max(410).optional().describe('page to put it on (default 1, the nearest); each page later costs about 10^2,340 more'),
      line: z.number().int().min(1).max(40).optional().describe('line to start on (needs page)'),
      col: z.number().int().min(1).max(80).optional().describe('column to start at (needs page and line)'),
      blank: z.boolean().optional().describe('leave the rest of that page empty instead of as it naturally falls'),
    }),
  }, wrap(async ({ text, page, line, col, blank }: { text: string; page?: number; line?: number; col?: number; blank?: boolean }) => {
    if (line !== undefined && page === undefined) throw new Error('line needs page: give the page to put it on as well');
    if (col !== undefined && line === undefined) throw new Error('col needs line (and page): give the line to start on as well');
    const at = line !== undefined ? (line - 1) * Babel.COLS + (col ?? 1) - 1 : undefined;
    const r = Babel.search(text, { page, at, blank });
    const nearby = Babel.bigToNumber(r.address.floor) !== null && Babel.bigToNumber(r.address.unit) !== null;
    return ok({
      side: Babel.SIDES[r.address.side], floor: Babel.describeBig(r.address.floor), unit: Babel.describeBig(r.address.unit),
      shelf: r.address.shelf + 1, book: r.address.slot + 1, page: r.page, line: r.line, col: r.col,
      pageText: r.text,
      onFoot: `${Babel.describeWalk(r.address)} from the spawn`,
    }, nearby && Babel.walkYearsLog10(r.address) < 0 ? 'Found, and near enough to walk to.' : 'Found. It is there. On foot it would take a while.');
  }));

  server.registerTool('finds', {
    description: 'The leaderboard of the rarest finds (runs of English words on the shelves, longest first), how long a find must be to place, '
      + 'and known finds within 200 m of you on your side and floor, with how far away each is, plus the best of the other side (the savages across the shaft) and of both. Walk there and open the book to read one.',
    inputSchema: z.object({}),
  }, wrap(async () => ok(await world.agentFinds(id))));

  server.registerTool('claim', {
    description: 'Claim finds for the leaderboard, up to 16 at once. Nobody scans for you: the text of every book is computed by the '
      + 'modules at /babel.js and /scan.js with the word list at /words.txt on this site (plain JavaScript; scan.js exports loadWords, '
      + 'scanUnit(floor, unit, words, min, side) and scanBook(address, words, min), whose finds carry page and at; side 0 is east, 1 west). '
      + 'Run them yourself, then claim. The server re-scans each claimed page and credits only a real run of words at exactly that spot, '
      + `and only if you were on that side and floor within ${R.CLAIM_METRES} m of it in the last ${R.CLAIM_WINDOW_S} s; the first claimant `
      + "keeps the credit, on that side's board.",
    inputSchema: z.object({
      finds: z.array(z.object({
        floor: z.number().int(), unit: z.number().int(),
        side: z.enum(['east', 'west']).optional().describe('the gallery it is in; yours if left out'),
        shelf: z.number().int().min(1).max(6), book: z.number().int().min(1).max(32),
        page: z.number().int().min(1).max(410),
        at: z.number().int().min(0).max(3199).describe('character offset on the page, 0-3199 in reading order (line * 80 + column, from 0)'),
        len: z.number().int().min(1).max(3200).optional().describe('its length; if left out, the run of words that starts at `at`'),
      })).min(1).max(16),
    }),
  }, wrap(async ({ finds }: { finds: AgentClaim[] }) => {
    const results = await world.agentClaim(id, finds);   // in the shape the tool takes: World turns it into addresses
    const won = results.filter(r => r.ok && r.first).length;
    return ok(results, won ? `You were first to ${won} of these.` : 'Checked.');
  }));

  server.registerTool('map', {
    description: "Everyone's most recent position (floor and metres along the gallery), who is present, and the farthest each has reached.",
    inputSchema: z.object({}),
  }, wrap(async () => ok(await world.map())));

  return server;
}
