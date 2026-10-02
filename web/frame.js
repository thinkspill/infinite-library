// Home or away: which frame of reference the player stands in. At home, the page's floors and units are the real
// ones and the world hears everything. After a teleport (local app only, for now) the world around you is the same
// but its addresses are shifted: local floor f, unit u is real floor origin.floor + f, unit origin.unit + u (big
// numbers, babel.js), and the world hears nothing until you are home again.
//
// This module is the one place that changes: go() (a teleport) and leave() (H, or the world saying where you are: a
// welcome on reconnect, a correction, night). Each change is told once to the listeners (the page: the finder's
// origin, the shelves, the marks, the near list, the player's pose), with `to`, the pose to stand at, or null when
// whoever called has already placed the player (the world's own position wins; the pose saved at the teleport is
// dropped). Pure: no DOM, no clock.
import { bigAddSmall } from './babel.js';

/**
 * @typedef {{ x: number, y: number, floor: number, side: number, yaw: number, pitch: number }} Pose
 * @typedef {{ floor: any, unit: any }} Origin   real floor and unit (babel.js bigs) of local floor 0, unit 0
 * @typedef {{ away: boolean, origin: Origin | null, to: Pose | null, why: string }} Change
 */
export function createFrame() {
  /** @type {null | { origin: Origin, home: Pose, hit: any }} */
  let away = null;
  /** @type {Array<(c: Change) => void>} */
  const listeners = [];
  const tell = (/** @type {Change} */ c) => { for (const f of listeners) f(c); };

  return {
    /** Listen for every change of frame: (change) => void. Returns a function that stops listening. */
    on(/** @type {(c: Change) => void} */ f) { listeners.push(f); return () => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); }; },
    /** Teleported, not home. */
    get away() { return !!away; },
    /** Real floor and unit of local floor 0, unit 0 while away; null at home. */
    get origin() { return away && away.origin; },
    /** The pose to come back to while away (where the teleport started); null at home. */
    get home() { return away && away.home; },
    /** The search hit that brought you here (opaque to this module); null at home. */
    get hit() { return away && away.hit; },
    /** Whether the world should hear nothing from us now (session.js `paused`). */
    paused() { return !!away; },
    /** A local address (floor, unit, side, shelf, slot) as the real one: shifted by the origin while away, itself at home. */
    real(/** @type {{ floor: number, unit: number, side?: number, shelf?: number, slot?: number }} */ b) {
      if (!away) return b;
      return { floor: bigAddSmall(away.origin.floor, b.floor), unit: bigAddSmall(away.origin.unit, b.unit), side: b.side, shelf: b.shelf, slot: b.slot };
    },
    /**
     * Teleport: stand at local unit `at` of local floor 0 with `hit.address` (real floor, unit) there, at pose `to`.
     * `from` is where you were; if already away, the first home is kept, not the far place you jumped from.
     * @param {{ hit: { address: { floor: any, unit: any } }, at: number, from: Pose, to: Pose }} o
     */
    go({ hit, at, from, to }) {
      const home = away ? away.home : { ...from };
      away = { origin: { floor: hit.address.floor, unit: bigAddSmall(hit.address.unit, -at) }, home, hit };
      tell({ away: true, origin: away.origin, to, why: 'teleport' });
    },
    /**
     * Come home, whatever the cause. why 'home' (you chose to: back to the pose saved at the teleport) or anything
     * else ('welcome', 'correct': the world placed you, so `to` is null). Not away: nothing happens, null is returned.
     * @param {string} [why]  @returns {Change | null}
     */
    leave(why = 'home') {
      if (!away) return null;
      const home = away.home; away = null;
      const c = { away: false, origin: null, to: why === 'home' ? home : null, why };
      tell(c);
      return c;
    },
  };
}
