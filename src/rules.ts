// The server's own numbers: what the shared modules don't say. The library's shape and movement (the gallery,
// shelves, stairs, the shaft, speeds, reach) are web/geometry.js's, the books are web/babel.js's and the shape of an
// address is web/protocol.js's: server code imports those directly, so there is one source for each and nothing here
// to drift. What stays here is how much slack the server allows a page's reports, where people arrive, where agents
// walk, and the claim window. scripts/check-geometry.ts checks this module copies nothing from those three.
import { SIDES } from '../web/babel.js';
import { STAIR_X0, STAIR_X1, REACH, RUN, SHELF_FACE } from '../web/geometry.js';
import { sideOf } from '../web/protocol.js';

// side: 0 east, 1 west, the two galleries facing each other across the shaft (babel.js SIDES); missing means 0.
// The same shape as web/protocol.js's Address typedef (whose isAddress is the test for one).
export interface Address { floor: number; unit: number; side?: number; shelf: number; slot: number }

// A find is credited only to someone who could have read it: on its floor, within CLAIM_METRES of it, at some time in
// the last CLAIM_WINDOW_S. The page's finder reads your floor only, up to about 105 m ahead when you run.
export const CLAIM_METRES = 160, CLAIM_WINDOW_S = 60;
export const SPAWN = { x: -3.2, y: 4, floor: 0, yaw: Math.PI / 2 };
// Agents walk the middle of the walkway, and climb in the middle of the stair band.
export const AGENT_X = -3.2, STAIR_X = (STAIR_X0 + STAIR_X1) / 2;

// Reach: a book can be taken down from where your feet are within REACH + REACH_SLACK of its unit on the shelf
// face; the page offers only books within REACH of your eye, so the slack absorbs reporting lag.
export const REACH_SLACK = 0.5;
export function shelfDistance(x: number, y: number, unit: number): number {
  return Math.hypot(x - SHELF_FACE, Math.max(unit, Math.min(unit + 1, y)) - y);
}
export const withinReach = (x: number, y: number, unit: number) => shelfDistance(x, y, unit) <= REACH + REACH_SLACK;
// Speed cap: between two reports dt seconds apart (dt clamped to MOVE_DT_MIN..MOVE_DT_MAX, so a client can't bank
// an hour of silence and spend it on one leap) a player moves at most running pace plus SPEED_SLACK for jitter, plus
// MOVE_STEP_SLACK metres for the step over the railing. Velocities reported are capped at RUN * SPEED_SLACK.
export const SPEED_SLACK = 1.25, MOVE_STEP_SLACK = 1.5, MOVE_DT_MIN = 0.1, MOVE_DT_MAX = 2;
export const moveDt = (ms: number) => Math.min(MOVE_DT_MAX, Math.max(MOVE_DT_MIN, ms / 1000));
export const maxHorizontal = (dt: number) => RUN * dt * SPEED_SLACK + MOVE_STEP_SLACK;
export const MAX_REPORTED_SPEED = RUN * SPEED_SLACK;
// How far a faller travelled when they changed sides: web/geometry.js crossingDistance, with the fall's mirror.

export const describeAddress = (a: Address) => `${SIDES[sideOf(a)]} side · floor ${a.floor} · unit ${a.unit} · shelf ${a.shelf + 1} · book ${a.slot + 1}`;
