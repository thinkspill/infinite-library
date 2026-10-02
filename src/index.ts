// The Worker: the front door. Static files are served by the assets layer before this runs; everything else
// (/, /ws, /mcp, /api/*) lands here and is routed to the single "world" Durable Object.
import { World } from './world';
import { handleMcp } from './mcp';
import { night } from './body';

export { World };

const json = (data: unknown, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store' } });

// Public reads that a crowd asks for at once (the board, the map) are kept here for a few seconds, per Worker
// instance, so a spike of map openings wakes the world a handful of times rather than once each. (workers.dev has
// no edge cache to lean on; browsers keep them the same few seconds.)
const memo = new Map<string, { at: number; value: unknown }>();
async function cached(key: string, ttlS: number, get: () => Promise<unknown>) {
  const hit = memo.get(key), now = Date.now();
  if (hit && now - hit.at < ttlS * 1000) return hit.value;
  const value = await get(); memo.set(key, { at: now, value });
  if (memo.size > 64) memo.delete(memo.keys().next().value!);
  return value;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const world = env.WORLD.get(env.WORLD.idFromName('world'));

    if (url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/short-stay-library', url), req));
    if (url.pathname === '/ws') return world.fetch(req);
    if (url.pathname === '/mcp') return handleMcp(req, env, ctx, world);

    if (url.pathname === '/api/hello') return json({ ok: true, night: night(env, Date.now()) });   // night needs no world: the clock and two settings
    if (url.pathname === '/api/map' && req.method === 'GET') return json(await cached('map', 10, () => world.map()), 200, 10);
    if (url.pathname === '/api/finds' && req.method === 'GET') {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
      return json(await cached(`finds:${limit}`, 15, () => world.leaderboard(limit)), 200, 15);
    }
    if (url.pathname === '/api/events' && req.method === 'GET')
      return json(await world.events(Number(url.searchParams.get('since')) || 0, Number(url.searchParams.get('limit')) || 100));

    if (url.pathname === '/api/admin/wipe' && req.method === 'POST') {
      if (!isOwner(req, env)) return json({ error: 'owner token required' }, 401);
      const body = await req.json().catch(() => ({})) as { confirm?: string };
      if (body.confirm !== 'wipe') return json({ error: 'send {"confirm": "wipe"}: this deletes every player, find, mark and event' }, 400);
      return json(await world.wipe());
    }
    if (url.pathname === '/api/admin/diag' && req.method === 'GET') {
      if (!isOwner(req, env)) return json({ error: 'owner token required' }, 401);
      return json(await world.diag(Number(url.searchParams.get('since')) || 0));
    }
    if (url.pathname === '/api/admin/player' && req.method === 'POST') {
      if (!isOwner(req, env)) return json({ error: 'owner token required' }, 401);
      const body = await req.json().catch(() => ({})) as { id?: string; rename?: string; remove?: boolean };
      const r = await world.moderate(String(body.id ?? ''), { rename: body.rename, remove: body.remove === true });
      return json(r, 'error' in r ? 400 : 200);
    }
    if (url.pathname === '/api/admin/reset' && req.method === 'POST') {
      if (!isOwner(req, env)) return json({ error: 'owner token required' }, 401);
      const body = await req.json().catch(() => ({})) as { names?: boolean; positions?: boolean; finds?: boolean };
      return json(await world.resetWorld({ names: !!body.names, positions: !!body.positions, finds: !!body.finds }));
    }

    // Owner endpoints: mint, list and revoke agent keys.
    if (url.pathname === '/api/agents' || url.pathname.startsWith('/api/agents/')) {
      if (!isOwner(req, env)) return json({ error: 'owner token required' }, 401);
      if (url.pathname === '/api/agents' && req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as { name?: string; ratePerMin?: number; side?: number };
        return json(await world.mintAgent(body.name ?? 'agent', body.ratePerMin ?? 60, body.side), 201);
      }
      if (url.pathname === '/api/agents' && req.method === 'GET') return json(await world.listAgents());
      const id = url.pathname.slice('/api/agents/'.length);
      if (id && req.method === 'DELETE') return json({ revoked: await world.revokeAgent(id) });
    }
    return json({ error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;

function isOwner(req: Request, env: Env) {
  const got = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const want = env.OWNER_TOKEN ?? '';
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}
