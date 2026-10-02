// The one Durable Object that is the library, addressed by name ("world"): a thin adapter that gives the world core
// (src/world-core.ts) what it needs from the Cloudflare runtime, its Host, and forwards to it every event (fetch,
// WebSocket message, close and error, alarm) and every RPC the Worker (src/index.ts) and the MCP tools (src/mcp.ts)
// make. Every rule lives in the core; nothing here decides anything.
import { DurableObject } from 'cloudflare:workers';
import { loadWords } from '../web/scan.js';
import WORDS_TXT from '../web/words.txt';
import { WorldCore, type Host, type Attachment } from './world-core';
import type { AgentClaim, MarkKind } from './body';

// The same word list the page scans with, parsed once when the Worker starts, not inside a request.
const WORDS = loadWords(WORDS_TXT);

export class World extends DurableObject<Env> {
  core: WorldCore<WebSocket>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const host: Host<WebSocket> = {
      sql: ctx.storage.sql,
      now: () => Date.now(),
      schedule: (ms, fn) => { setTimeout(fn, ms); },
      alarm: { get: () => ctx.storage.getAlarm(), set: at => ctx.storage.setAlarm(at) },
      sockets: {
        list: () => ctx.getWebSockets(),
        send: (ws, text) => ws.send(text),
        close: (ws, code, reason) => ws.close(code, reason),
        attachment: ws => ws.deserializeAttachment() as Attachment | null,
        attach: (ws, a) => ws.serializeAttachment(a),
      },
      settings: env as unknown as Record<string, unknown>,
      words: WORDS,
    };
    this.core = new WorldCore(host);
    ctx.blockConcurrencyWhile(() => this.core.wake());
  }

  // ------------------------------------------------------------------ runtime events
  async fetch(req: Request): Promise<Response> {
    this.core.count('requests');
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
    let client: WebSocket | null = null;
    const r = this.core.connect(req.headers.get('CF-Connecting-IP') ?? 'unknown', () => {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      client = pair[0];
      return pair[1];
    });
    return r.ok ? new Response(null, { status: 101, webSocket: client }) : new Response(r.reason, { status: r.status });
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) { await this.core.message(ws, raw); }
  async webSocketClose(ws: WebSocket) { this.core.closed(ws); }
  async webSocketError(ws: WebSocket) { this.core.closed(ws); }
  async alarm() { await this.core.alarm(); }

  // ------------------------------------------------------------------ RPC: the owner's API (src/index.ts)
  map() { return this.core.map(); }
  leaderboard(limit: number) { return this.core.leaderboard(limit); }
  events(since: number, limit: number) { return this.core.events(since, limit); }
  wipe() { return this.core.wipe(); }
  diag(since = 0) { return this.core.diag(since); }
  moderate(pubId: string, what: { rename?: string; remove?: boolean }) { return this.core.moderate(pubId, what); }
  resetWorld(what: { names?: boolean; positions?: boolean; finds?: boolean }) { return this.core.resetWorld(what); }
  mintAgent(name: string, ratePerMin: number, side?: unknown) { return this.core.mintAgent(name, ratePerMin, side); }
  listAgents() { return this.core.listAgents(); }
  revokeAgent(id: string) { return this.core.revokeAgent(id); }

  // ------------------------------------------------------------------ RPC: the agents' verbs (src/mcp.ts)
  authAgent(key: string) { return this.core.authAgent(key); }
  agentLook(id: string, afterTravel = false) { return this.core.agentLook(id, afterTravel); }
  agentWalk(id: string, metres: number, run: boolean) { return this.core.agentWalk(id, metres, run); }
  agentClimb(id: string, where: 'up' | 'down' | 'railing') { return this.core.agentClimb(id, where); }
  agentOpen(id: string, shelf: number, book: number, unit?: number) { return this.core.agentOpen(id, shelf, book, unit); }
  agentPage(id: string, n: number) { return this.core.agentPage(id, n); }
  agentMark(id: string, kind: MarkKind) { return this.core.agentMark(id, kind); }
  agentFinds(id: string) { return this.core.agentFinds(id); }
  agentClaim(id: string, finds: AgentClaim[]) { return this.core.agentClaim(id, finds); }
}
