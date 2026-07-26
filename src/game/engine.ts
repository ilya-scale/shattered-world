// Pure, deterministic rules engine for Shattered World, implementing
// Rules.docx v1.0. Both peers apply the same actions to the same state (with
// a shared RNG seed), so only actions ever travel over the wire.
//
// Turn structure ("Player's Turn"):
//   1. gaining mana   — +1 per mana source you control, applied at turn start
//   2. summoning      — only until your first move/attack of the turn
//   3. moving & attacking — any order; one move action + one attack per unit
//      (exceptions: mounted archer splits its move, barbarian attacks twice)

import { DIRS, hexDist, hexKey, keyOf, type Hex } from './hex';
import {
  GRADE, PASSABLE, STATS, halfCost, other,
  type Faction, type Terrain, type UnitType,
} from './data';
import { MAPS, type MapDef, type MapId } from './maps';

export type GameMode = 'control' | 'gathering' | 'battle';

export interface Unit {
  id: number;
  type: UnitType;
  faction: Faction;
  q: number;
  r: number;
  hp: number;
  /* per-turn state */
  movePts: number;
  moveActs: number;
  attacks: number;
  /** true once the unit moved this turn (rules: move→attack forbids further movement). */
  moved: boolean;
  /** set when the unit attacks after moving — no more movement this turn. */
  moveLocked: boolean;
  /** healer/translocator: continuing applications of the same consumed ability. */
  abilityLock: { kind: 'heal' | 'wound'; targetId: number } | null;
}

export interface SourceState extends Hex {
  owner: Faction | null;
}

export interface FactionStats {
  felled: number;
  lost: number;
  manaSpent: number;
  biggestHit: number;
  dice: number;
  shifts: number;
}

export interface Combat {
  attacker: { name: string; die: number; add: number };
  defender: { name: string; die: number; add: number };
  dmg: number;
  splash: string[];
  killed: string[];
}

export interface LogEntry {
  /** full round number when it happened */
  t: number;
  f: Faction;
  kind: 'summon' | 'move' | 'attack' | 'shift' | 'heal' | 'wound'
    | 'translocate' | 'banish' | 'turn' | 'resign';
  text: string;
  /** merge key for repeated 1-mana applications (heal/wound) */
  key?: string;
  n?: number;
}

export interface GameState {
  mode: GameMode;
  mapId: MapId;
  startMana: number;
  /** Gathering: win when your mana reaches this. */
  goalMana: number;
  units: Unit[];
  nextId: number;
  sources: SourceState[];
  turn: Faction;
  /** full rounds played, 1-based; increments when play returns to the first player. */
  turnNum: number;
  first: Faction;
  mana: Record<Faction, number>;
  /** any move/attack happened this turn — summoning closes. */
  actedThisTurn: boolean;
  everSummoned: Record<Faction, boolean>;
  /** Control mode: consecutive full control cycles completed. Win at 3. */
  control: Record<Faction, number>;
  /** Faction that began its current cycle controlling every source. */
  pendingControl: Faction | null;
  /** Gathering: first player reached the goal; second gets one extra turn. */
  gatherExtra: Faction | null;
  rng: number;
  lastCombat: Combat | null;
  lastEvent: string | null;
  /** chronological battle log, identical on both peers */
  log: LogEntry[];
  winner: Faction | null;
  draw: boolean;
  stats: Record<Faction, FactionStats>;
}

export type GameAction =
  | { kind: 'summon'; ut: UnitType; q: number; r: number }
  | { kind: 'move'; id: number; q: number; r: number }
  | { kind: 'planeswalk'; id: number; q: number; r: number }
  | { kind: 'attack'; id: number; q: number; r: number }
  | { kind: 'shift'; id: number; q: number; r: number }
  | { kind: 'heal'; id: number; targetId: number }
  | { kind: 'wound'; id: number; targetId: number }
  | { kind: 'translocate'; id: number; targetId: number; q: number; r: number }
  | { kind: 'banish'; id: number; targetId: number }
  | { kind: 'endTurn' }
  | { kind: 'resign'; faction: Faction };

/* ---------- RNG: mulberry32, advanced inside the state ---------- */

function nextRng(s: number): [number, number] {
  let t = (s + 0x6d2b79f5) | 0;
  let x = t;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  const out = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return [out, t];
}

/** Roll 1d6, returning the value and threading the RNG state. */
function rollD6(g: GameState): number {
  const [v, s] = nextRng(g.rng);
  g.rng = s;
  return 1 + Math.floor(v * 6);
}

/* ---------- helpers ---------- */

export const mapOf = (g: GameState): MapDef => MAPS[g.mapId];

export const terrainAt = (g: GameState, q: number, r: number): Terrain | undefined =>
  mapOf(g).terrain.get(hexKey(q, r));

export const unitAt = (g: GameState, q: number, r: number): Unit | undefined =>
  g.units.find((u) => u.q === q && u.r === r);

export const sourceAt = (g: GameState, q: number, r: number): SourceState | undefined =>
  g.sources.find((s) => s.q === q && s.r === r);

const freshStats = (): FactionStats => ({
  felled: 0, lost: 0, manaSpent: 0, biggestHit: 0, dice: 0, shifts: 0,
});

function resetUnitTurn(u: Unit): void {
  const s = STATS[u.type];
  u.movePts = s.move;
  u.moveActs = s.moveActsPerTurn ?? 1;
  u.attacks = s.attacksPerTurn ?? 1;
  u.moved = false;
  u.moveLocked = false;
  u.abilityLock = null;
}

function mkUnit(g: GameState, type: UnitType, faction: Faction, q: number, r: number): Unit {
  const u: Unit = {
    id: g.nextId++, type, faction, q, r, hp: STATS[type].life,
    movePts: 0, moveActs: 0, attacks: 0, moved: false, moveLocked: false, abilityLock: null,
  };
  resetUnitTurn(u);
  return u;
}

export function createGame(seed: number, mode: GameMode, startMana: number, first: Faction, mapId: MapId = 'isle'): GameState {
  const sources: SourceState[] =
    mode === 'battle' ? [] : MAPS[mapId].sources.map((s) => ({ ...s, owner: null }));
  return {
    mode,
    mapId,
    startMana,
    goalMana: startMana * 2,
    units: [],
    nextId: 1,
    sources,
    turn: first,
    turnNum: 1,
    first,
    mana: { a: startMana, b: startMana },
    actedThisTurn: false,
    everSummoned: { a: false, b: false },
    control: { a: 0, b: 0 },
    pendingControl: null,
    gatherExtra: null,
    rng: seed | 0,
    lastCombat: null,
    lastEvent: null,
    log: [],
    winner: null,
    draw: false,
    stats: { a: freshStats(), b: freshStats() },
  };
}

function pushLog(g: GameState, kind: LogEntry['kind'], text: string, key?: string): void {
  g.log.push({ t: g.turnNum, f: g.turn, kind, text, key, n: 1 });
  if (g.log.length > 400) g.log.shift();
}

/** In Battle mode the source hexes revert to plain grass. */
export function effectiveTerrain(g: GameState, q: number, r: number): Terrain | undefined {
  const t = terrainAt(g, q, r);
  if (t === 'source' && g.mode === 'battle') return 'grass';
  return t;
}

function standable(g: GameState, q: number, r: number): boolean {
  const t = effectiveTerrain(g, q, r);
  return !!t && PASSABLE[t] && !unitAt(g, q, r);
}

/** Elevation rule: move / melee-attack only across ≤ 1 grade difference. */
export function gradeOk(g: GameState, from: Hex, to: Hex): boolean {
  const a = effectiveTerrain(g, from.q, from.r);
  const b = effectiveTerrain(g, to.q, to.r);
  if (!a || !b) return false;
  return Math.abs(GRADE[a] - GRADE[b]) <= 1;
}

/* ---------- movement ---------- */

export interface ReachCell extends Hex {
  /** total steps to get there */
  n: number;
  /** mana the move would cost (steps beyond remaining move points — swordsman only) */
  manaCost: number;
}

/**
 * Dijkstra over passable, elevation-legal, unoccupied hexes. Budget is the
 * unit's remaining move points, plus banked mana for the swordsman's
 * "+1 move per 1 mana".
 */
export function reachableCells(g: GameState, u: Unit): ReachCell[] {
  if (u.moveActs <= 0 || u.moveLocked) return [];
  const manaBudget = u.type === 'swordsman' ? g.mana[u.faction] : 0;
  const budget = u.movePts + manaBudget;
  if (budget <= 0) return [];

  const dist = new Map<string, number>([[keyOf(u), 0]]);
  const queue: Array<[number, Hex]> = [[0, { q: u.q, r: u.r }]];
  while (queue.length) {
    queue.sort((x, y) => x[0] - y[0]);
    const [d, c] = queue.shift()!;
    if (d > (dist.get(keyOf(c)) ?? Infinity)) continue;
    for (const [dq, dr] of DIRS) {
      const n = { q: c.q + dq, r: c.r + dr };
      const k = keyOf(n);
      if (!mapOf(g).terrain.has(k) || !standable(g, n.q, n.r) || !gradeOk(g, c, n)) continue;
      const nd = d + 1;
      if (nd <= budget && nd < (dist.get(k) ?? Infinity)) {
        dist.set(k, nd);
        queue.push([nd, n]);
      }
    }
  }
  const out: ReachCell[] = [];
  for (const [k, n] of dist) {
    if (n === 0) continue;
    const [q, r] = k.split(',').map(Number);
    out.push({ q, r, n, manaCost: Math.max(0, n - u.movePts) });
  }
  return out;
}

/** Planeswalker: any free standable hex within `mana` hex-distance, ✦1/hex. */
export function planeswalkCells(g: GameState, u: Unit): ReachCell[] {
  if (u.type !== 'planeswalker' || u.moveActs <= 0 || u.moveLocked) return [];
  const budget = g.mana[u.faction];
  const out: ReachCell[] = [];
  for (const [k] of mapOf(g).terrain) {
    const [q, r] = k.split(',').map(Number);
    const d = hexDist(u, { q, r });
    if (d >= 1 && d <= budget && standable(g, q, r)) {
      out.push({ q, r, n: d, manaCost: d });
    }
  }
  return out;
}

/* ---------- combat targeting ---------- */

/** +2 DEF beside a friendly Defender ("bonuses don't stack"). */
export const defenderAura = (g: GameState, d: Unit): number =>
  g.units.some(
    (o) => o.faction === d.faction && o.id !== d.id && o.type === 'defender' && hexDist(o, d) === 1,
  )
    ? 2
    : 0;

export interface TargetCell extends Hex {
  manaCost: number;
}

/** Enemy units this unit may attack right now (with archer's paid reach). */
export function attackTargets(g: GameState, u: Unit): TargetCell[] {
  const s = STATS[u.type];
  if (s.atk === null || u.attacks <= 0) return [];
  const maxR = s.rng + (u.type === 'archer' ? g.mana[u.faction] : 0);
  const out: TargetCell[] = [];
  for (const e of g.units) {
    if (e.faction === u.faction) continue;
    const d = hexDist(u, e);
    if (d > maxR) continue;
    if (s.minRng && d < s.minRng) continue;
    if (s.rng === 1) {
      // melee: adjacent and within one elevation grade
      if (d !== 1 || !gradeOk(g, u, e)) continue;
    }
    out.push({ q: e.q, r: e.r, manaCost: Math.max(0, d - s.rng) });
  }
  return out;
}

/** Neutral or enemy sources adjacent to the unit (shift ignores range). */
export function shiftTargets(g: GameState, u: Unit): SourceState[] {
  if (STATS[u.type].atk === null || u.attacks <= 0) return [];
  return g.sources.filter((s) => s.owner !== u.faction && hexDist(u, s) === 1);
}

export function summonCells(g: GameState, f: Faction): Hex[] {
  return mapOf(g).portals[f].filter((p) => !unitAt(g, p.q, p.r));
}

export function translocateDests(g: GameState, t: Unit): Hex[] {
  const out: Hex[] = [];
  for (const [k] of mapOf(g).terrain) {
    const [q, r] = k.split(',').map(Number);
    const d = hexDist(t, { q, r });
    if (d >= 1 && d <= STATS.translocator.rng && standable(g, q, r)) out.push({ q, r });
  }
  return out;
}

/* ---------- "anything left to do?" (drives the end-of-turn nudge) ---------- */

/** Could this unit still take a useful action this turn? */
export function unitCanAct(g: GameState, u: Unit): boolean {
  if (u.faction !== g.turn) return false;
  const s = STATS[u.type];
  const mana = g.mana[u.faction];

  if (
    u.moveActs > 0 && !u.moveLocked &&
    (u.movePts > 0 || (u.type === 'swordsman' && mana >= 1)) &&
    reachableCells(g, u).length > 0
  ) {
    return true;
  }
  if (u.type === 'planeswalker' && u.moveActs > 0 && !u.moveLocked && mana >= 1 &&
    planeswalkCells(g, u).length > 0) {
    return true;
  }
  if (s.atk !== null && u.attacks > 0) {
    if (attackTargets(g, u).length > 0) return true;
    if (shiftTargets(g, u).length > 0) return true;
  }
  if (u.type === 'healer' && mana >= 1) {
    const locked = u.abilityLock;
    if (locked || u.attacks > 0) {
      for (const t of g.units) {
        if (hexDist(u, t) > s.rng) continue;
        if (locked && locked.targetId !== t.id) continue;
        const kind = locked?.kind;
        // healing a full-health ally does nothing — don't count it as an action
        if ((kind === 'heal' || !kind) && t.faction === u.faction && t.hp < STATS[t.type].life) return true;
        if ((kind === 'wound' || !kind) && t.faction !== u.faction) return true;
      }
    }
  }
  if (u.type === 'translocator' && u.attacks > 0) {
    const hasDest = translocateDests(g, u).length > 0;
    for (const t of g.units) {
      if (t.id === u.id) continue;
      if (t.faction === u.faction && hexDist(u, t) === 1 && mana >= halfCost(t.type) && hasDest) return true;
      if (t.faction !== u.faction && hexDist(u, t) <= s.rng && mana >= halfCost(t.type) &&
        summonCells(g, t.faction).length > 0) return true;
    }
  }
  return false;
}

const CHEAPEST_UNIT = Math.min(...Object.values(STATS).map((s) => s.cost));

/** Could the current player still summon something this turn? */
export function canSummon(g: GameState): boolean {
  return !g.actedThisTurn && g.mana[g.turn] >= CHEAPEST_UNIT && summonCells(g, g.turn).length > 0;
}

/* ---------- internal mutations (operate on a cloned state) ---------- */

function spendMana(g: GameState, f: Faction, n: number): void {
  g.mana[f] -= n;
  g.stats[f].manaSpent += n;
}

function afterOffense(g: GameState, u: Unit): void {
  // attack-equivalent action: consume an attack; lock movement if the unit
  // already moved (move→attack→move is barred — mounted archer excepted).
  u.attacks -= 1;
  if (u.moved && u.type !== 'mountedarcher') u.moveLocked = true;
  g.actedThisTurn = true;
}

function removeDead(g: GameState, killer: Faction | null): string[] {
  const dead = g.units.filter((u) => u.hp <= 0);
  if (!dead.length) return [];
  g.units = g.units.filter((u) => u.hp > 0);
  for (const d of dead) {
    g.stats[d.faction].lost += 1;
    if (killer && killer !== d.faction) g.stats[killer].felled += 1;
  }
  return dead.map((d) => STATS[d.type].name);
}

function checkBattleWipe(g: GameState): void {
  if (g.mode !== 'battle' || g.winner) return;
  for (const f of ['a', 'b'] as const) {
    if (g.everSummoned[f] && g.units.every((u) => u.faction !== f)) {
      g.winner = other(f);
      return;
    }
  }
}

/* ---------- the reducer ---------- */

export class RuleError extends Error {}

function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new RuleError(msg);
}

/** Apply an action, returning the next state. Throws RuleError on illegal moves. */
export function applyAction(prev: GameState, action: GameAction): GameState {
  const g: GameState = structuredClone(prev);
  g.lastCombat = null;
  g.lastEvent = null;

  if (action.kind === 'resign') {
    need(!g.winner, 'game over');
    g.winner = other(action.faction);
    g.lastEvent = 'resigned';
    g.log.push({ t: g.turnNum, f: action.faction, kind: 'resign', text: 'lays down arms', n: 1 });
    return g;
  }

  need(!g.winner && !g.draw, 'game over');
  const f = g.turn;

  if (action.kind === 'endTurn') {
    endTurn(g);
    return g;
  }

  if (action.kind === 'summon') {
    need(!g.actedThisTurn, 'summoning ends once you move or attack');
    const cost = STATS[action.ut].cost;
    need(g.mana[f] >= cost, 'not enough mana');
    need(
      summonCells(g, f).some((c) => c.q === action.q && c.r === action.r),
      'summon onto a free hex of your portal',
    );
    spendMana(g, f, cost);
    g.units.push(mkUnit(g, action.ut, f, action.q, action.r));
    g.everSummoned[f] = true;
    g.lastEvent = `${STATS[action.ut].name} summoned`;
    pushLog(g, 'summon', `summons a ${STATS[action.ut].name} (✦${cost})`);
    return g;
  }

  const u = g.units.find((x) => x.id === (action as { id: number }).id);
  need(u, 'no such unit');
  need(u.faction === f, 'not your unit');

  switch (action.kind) {
    case 'move': {
      const cell = reachableCells(g, u).find((c) => c.q === action.q && c.r === action.r);
      need(cell, 'unreachable');
      if (cell.manaCost > 0) spendMana(g, f, cell.manaCost);
      u.q = action.q;
      u.r = action.r;
      u.movePts = Math.max(0, u.movePts - cell.n);
      u.moveActs -= 1;
      if (u.moveActs <= 0) u.movePts = 0;
      u.moved = true;
      g.actedThisTurn = true;
      pushLog(g, 'move', `${STATS[u.type].name} marches ${cell.n} hex${cell.n > 1 ? 'es' : ''}${cell.manaCost > 0 ? ` (forced march ✦${cell.manaCost})` : ''}`);
      break;
    }

    case 'planeswalk': {
      const cell = planeswalkCells(g, u).find((c) => c.q === action.q && c.r === action.r);
      need(cell, 'out of planeswalk reach');
      spendMana(g, f, cell.manaCost);
      u.q = action.q;
      u.r = action.r;
      u.moveActs -= 1;
      u.movePts = 0;
      u.moved = true;
      g.actedThisTurn = true;
      g.lastEvent = 'planeswalked';
      pushLog(g, 'move', `Planeswalker steps between worlds — ${cell.n} hexes (✦${cell.manaCost})`);
      break;
    }

    case 'attack': {
      const t = attackTargets(g, u).find((c) => c.q === action.q && c.r === action.r);
      need(t, 'target out of reach');
      const target = unitAt(g, action.q, action.r);
      need(target && target.faction !== f, 'no enemy there');
      if (t.manaCost > 0) spendMana(g, f, t.manaCost);

      const s = STATS[u.type];
      const atkDie = rollD6(g);
      const defDie = rollD6(g);
      g.stats[f].dice += 1;
      g.stats[target.faction].dice += 1;
      const defAdd = STATS[target.type].def + defenderAura(g, target);
      const atkTotal = atkDie + (s.atk as number);
      const defTotal = defDie + defAdd;
      const dmg = Math.max(0, atkTotal - defTotal);
      target.hp -= dmg;
      if (dmg > g.stats[f].biggestHit) g.stats[f].biggestHit = dmg;

      // catapult splash: 1 automatic damage to all units adjacent to the
      // target hex (not the target itself) — no dice, friend and foe alike
      const splashed: string[] = [];
      if (s.splash) {
        for (const [dq, dr] of DIRS) {
          const nb = unitAt(g, action.q + dq, action.r + dr);
          if (nb && nb.id !== target.id) {
            nb.hp -= s.splash;
            splashed.push(STATS[nb.type].name);
          }
        }
      }

      const killed = removeDead(g, f);
      g.lastCombat = {
        attacker: { name: s.name, die: atkDie, add: s.atk as number },
        defender: { name: STATS[target.type].name, die: defDie, add: defAdd },
        dmg,
        splash: splashed,
        killed,
      };
      pushLog(
        g, 'attack',
        `${s.name} ${atkTotal} (${atkDie}+${s.atk}) vs ${STATS[target.type].name} ${defTotal} (${defDie}+${defAdd}) — ` +
          (dmg > 0 ? `${dmg} damage` : 'deflected') +
          (splashed.length ? ` · splash on ${splashed.join(', ')}` : '') +
          (killed.length ? ` · ${killed.join(', ')} falls` : ''),
      );
      afterOffense(g, u);
      checkBattleWipe(g);
      break;
    }

    case 'shift': {
      const src = shiftTargets(g, u).find((s) => s.q === action.q && s.r === action.r);
      need(src, 'no shiftable source there');
      const real = sourceAt(g, action.q, action.r)!;
      real.owner = f;
      g.stats[f].shifts += 1;
      afterOffense(g, u);
      g.lastEvent = 'source shifted';
      pushLog(g, 'shift', `${STATS[u.type].name} shifts a mana Source`);
      break;
    }

    case 'heal':
    case 'wound': {
      need(u.type === 'healer', 'only the healer mends or wounds');
      const target = g.units.find((x) => x.id === action.targetId);
      need(target, 'no such target');
      need(hexDist(u, target) <= STATS.healer.rng, 'out of range');
      need(g.mana[f] >= 1, 'not enough mana');
      if (action.kind === 'heal') need(target.faction === f, 'heal your own units');
      else need(target.faction !== f, 'wound the enemy');

      const locked = u.abilityLock;
      if (locked) {
        // "can use ability several times simultaneously" — keep paying into
        // the same application, but it stays one attack-equivalent action
        need(locked.kind === action.kind && locked.targetId === target.id,
          'ability already committed elsewhere this turn');
      } else {
        need(u.attacks > 0, 'already acted');
        afterOffense(g, u);
        u.abilityLock = { kind: action.kind, targetId: target.id };
      }
      spendMana(g, f, 1);
      const tName = STATS[target.type].name;
      const mergeKey = `${action.kind}:${u.id}:${target.id}`;
      const last = g.log[g.log.length - 1];
      const verb = action.kind === 'heal' ? 'mends' : 'wounds';
      const sign = action.kind === 'heal' ? '+' : '−';
      if (last && last.key === mergeKey) {
        last.n = (last.n ?? 1) + 1;
        last.text = `Healer ${verb} ${tName} (${sign}${last.n})`;
      } else {
        pushLog(g, action.kind, `Healer ${verb} ${tName} (${sign}1)`, mergeKey);
      }
      g.lastEvent = `Healer ${verb} ${tName}`;
      if (action.kind === 'heal') {
        target.hp = Math.min(STATS[target.type].life, target.hp + 1);
      } else {
        target.hp -= 1;
        const killed = removeDead(g, f);
        if (killed.length) {
          g.lastEvent = `${killed.join(', ')} succumbs`;
          pushLog(g, 'wound', `${killed.join(', ')} succumbs to its wounds`);
        }
        checkBattleWipe(g);
      }
      break;
    }

    case 'translocate': {
      need(u.type === 'translocator', 'only the translocator');
      need(u.attacks > 0, 'already acted');
      const target = g.units.find((x) => x.id === action.targetId);
      need(target && target.faction === f, 'pick a friendly unit');
      need(hexDist(u, target) === 1, 'the ally must stand beside the translocator');
      need(
        translocateDests(g, u).some((c) => c.q === action.q && c.r === action.r),
        'destination out of range',
      );
      const cost = halfCost(target.type);
      need(g.mana[f] >= cost, 'not enough mana');
      spendMana(g, f, cost);
      target.q = action.q;
      target.r = action.r;
      afterOffense(g, u);
      g.lastEvent = `${STATS[target.type].name} translocated`;
      pushLog(g, 'translocate', `Translocator sends ${STATS[target.type].name} through the weave (✦${cost})`);
      break;
    }

    case 'banish': {
      need(u.type === 'translocator', 'only the translocator');
      need(u.attacks > 0, 'already acted');
      const target = g.units.find((x) => x.id === action.targetId);
      need(target && target.faction !== f, 'pick an enemy unit');
      need(hexDist(u, target) <= STATS.translocator.rng, 'out of range');
      const cost = halfCost(target.type);
      need(g.mana[f] >= cost, 'not enough mana');
      const slot = summonCells(g, target.faction)[0];
      need(slot, 'the enemy portal is full');
      spendMana(g, f, cost);
      target.q = slot.q;
      target.r = slot.r;
      afterOffense(g, u);
      g.lastEvent = `${STATS[target.type].name} banished`;
      pushLog(g, 'banish', `Translocator banishes the enemy ${STATS[target.type].name} to its portal (✦${cost})`);
      break;
    }
  }

  return g;
}

/* ---------- end of turn / victory bookkeeping ---------- */

function allSourcesOwned(g: GameState, f: Faction): boolean {
  return g.sources.length > 0 && g.sources.every((s) => s.owner === f);
}

function endTurn(g: GameState): void {
  const ending = g.turn;
  pushLog(g, 'turn', 'ends the turn');

  // Control: "one [turn] counts if at the beginning of your turn all the
  // sources were under your control, and they still remain so at the end of
  // the enemy's turn."
  if (g.mode === 'control' && g.pendingControl === other(ending)) {
    const holder = g.pendingControl;
    if (allSourcesOwned(g, holder)) {
      g.control[holder] += 1;
      if (g.control[holder] >= 3) g.winner = holder;
    } else {
      g.control[holder] = 0;
    }
    g.pendingControl = null;
  }

  // Gathering: first to reach the goal, with the second player getting one
  // extra turn if the first-mover hits it first.
  if (g.mode === 'gathering' && !g.winner) {
    const m = g.mana[ending];
    if (g.gatherExtra === ending) {
      // this was the catch-up turn
      const rival = other(ending);
      if (m >= g.goalMana && m > g.mana[rival]) g.winner = ending;
      else if (m >= g.goalMana && m === g.mana[rival]) g.draw = true;
      else g.winner = rival;
    } else if (m >= g.goalMana) {
      if (ending === g.first) g.gatherExtra = other(ending);
      else g.winner = ending;
    }
  }

  checkBattleWipe(g);
  if (g.winner || g.draw) return;

  const next = other(ending);
  g.turn = next;
  if (next === g.first) g.turnNum += 1;
  g.actedThisTurn = false;

  // gaining mana: +1 per source you control at the start of your turn
  const income = g.sources.filter((s) => s.owner === next).length;
  g.mana[next] += income;

  for (const u of g.units) {
    if (u.faction === next) resetUnitTurn(u);
  }

  if (g.mode === 'control') {
    if (allSourcesOwned(g, next)) g.pendingControl = next;
  }
}
