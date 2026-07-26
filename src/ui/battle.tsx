// The live battle screen: selection, movement (with step counts and a route
// preview), dice combat, source shifting, every unit special, summoning and
// the end-turn loop — visuals per the design canvas, mechanics per Rules.docx.

import { useEffect, useMemo, useRef, useState } from 'react';
import { DIRS, hexDist, keyOf, type Hex } from '../game/hex';
import { PASSABLE, STATS, halfCost, type Faction, type UnitType } from '../game/data';
import {
  attackTargets, canSummon, defenderAura, effectiveTerrain, gradeOk, mapOf,
  planeswalkCells, reachableCells, shiftTargets, summonCells, translocateDests,
  unitAt, unitCanAct,
  type GameAction, type GameState, type Unit,
} from '../game/engine';
import { hexesOf, type MapDef } from '../game/maps';
import { Board, type DisplayUnit, type Overlay, type OverlayCell, type Tip } from './board';
import { CombatPanel, Screen, SummonDock, TopBar, UnitCard, type CardAction } from './panels';

type UiMode =
  | 'idle' | 'move' | 'planeswalk' | 'attack' | 'shift'
  | 'heal' | 'wound' | 'transloc-pick' | 'transloc-dest' | 'banish' | 'summon';

const within = (map: MapDef, o: Hex, n: number): Hex[] =>
  hexesOf(map).filter((h) => {
    const d = hexDist(o, h);
    return d >= 1 && d <= n;
  });

function routeTo(u: Unit, cell: Hex, reach: Array<Hex & { n: number }>): Hex[] {
  const n = new Map<string, number>([[keyOf(u), 0]]);
  reach.forEach((c) => n.set(keyOf(c), c.n));
  let cur = cell;
  const out: Hex[] = [cell];
  for (let i = 0; i < 40; i++) {
    if (cur.q === u.q && cur.r === u.r) break;
    let best: Hex | null = null;
    for (const [dq, dr] of DIRS) {
      const k = (cur.q + dq) + ',' + (cur.r + dr);
      if (!n.has(k)) continue;
      if (!best || n.get(k)! < n.get(keyOf(best))!) best = { q: cur.q + dq, r: cur.r + dr };
    }
    if (!best) break;
    out.push(best);
    cur = best;
  }
  return out.reverse();
}

const FACTION_NAME: Record<Faction, string> = { a: 'Azure Vanguard', b: 'Crimson Horde' };

export function BattleScreen({ g, me, hotseat, dispatch, onResign }: {
  g: GameState;
  me: Faction;
  hotseat: boolean;
  dispatch: (a: GameAction) => boolean;
  onResign: () => void;
}) {
  const my: Faction = hotseat ? g.turn : me;
  const myTurn = (hotseat || g.turn === me) && !g.winner && !g.draw;
  const map = mapOf(g);

  const [selId, setSelId] = useState<number | null>(null);
  const [mode, setMode] = useState<UiMode>('idle');
  const [summonType, setSummonType] = useState<UnitType | null>(null);
  const [translocId, setTranslocId] = useState<number | null>(null);
  const [hover, setHover] = useState<Hex | null>(null);
  const [msg, setMsg] = useState<string>('Click one of your units to begin — or summon from the dock.');
  const [combat, setCombat] = useState<GameState['lastCombat']>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  const sel = selId != null ? g.units.find((u) => u.id === selId) ?? null : null;

  // surface dice results (also for the remote player's attacks)
  useEffect(() => {
    if (g.lastCombat) {
      setCombat(g.lastCombat);
      const t = setTimeout(() => setCombat(null), 6500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [g.lastCombat, g.units]);

  // narrate the opponent's actions (heals, shifts, summons … — attacks
  // already show the dice panel, turn changes show the banner)
  const lastEntry = g.log[g.log.length - 1];
  useEffect(() => {
    if (!lastEntry || hotseat) return undefined;
    if (lastEntry.f === me || lastEntry.kind === 'attack' || lastEntry.kind === 'turn') return undefined;
    setToast(`${FACTION_NAME[lastEntry.f]} · ${lastEntry.text}`);
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [lastEntry, me, hotseat]);

  // reset interaction state when the turn changes hands
  const turnKey = g.turn + ':' + g.turnNum;
  const prevTurn = useRef(turnKey);
  useEffect(() => {
    if (prevTurn.current !== turnKey) {
      prevTurn.current = turnKey;
      setSelId(null);
      setMode('idle');
      setSummonType(null);
      setHover(null);
      setMsg(
        myTurn
          ? 'Your turn — summon first if you wish; the portal closes once you act.'
          : '',
      );
    }
  }, [turnKey, myTurn]);

  const trySend = (a: GameAction, note?: string) => {
    const ok = dispatch(a);
    if (ok && note) setMsg(note);
    return ok;
  };

  const deselect = () => {
    setSelId(null);
    setMode('idle');
    setSummonType(null);
    setTranslocId(null);
    setHover(null);
  };

  const selectUnit = (u: Unit) => {
    setSelId(u.id);
    setSummonType(null);
    setTranslocId(null);
    if (u.faction === my && myTurn) {
      setMode('move');
      setMsg(`${STATS[u.type].name} — choose an action on the card.`);
    } else {
      setMode('idle');
    }
  };

  const onCell = (q: number, r: number) => {
    const u = unitAt(g, q, r);
    // clicking the selected unit again puts it down
    if (u && sel && u.id === sel.id && mode !== 'heal') {
      deselect();
      return;
    }
    if (!myTurn) {
      if (u) selectUnit(u);
      return;
    }
    if (mode === 'summon' && summonType) {
      if (summonCells(g, my).some((c) => c.q === q && c.r === r)) {
        if (trySend({ kind: 'summon', ut: summonType, q, r }, `${STATS[summonType].name} answers the call.`)) {
          setSummonType(null);
          setMode('idle');
        }
        return;
      }
    }
    if (sel && sel.faction === my) {
      switch (mode) {
        case 'move':
          if (!u && reachableCells(g, sel).some((c) => c.q === q && c.r === r)) {
            trySend({ kind: 'move', id: sel.id, q, r }, 'Moved.');
            setHover(null);
            return;
          }
          break;
        case 'planeswalk':
          if (!u && planeswalkCells(g, sel).some((c) => c.q === q && c.r === r)) {
            trySend({ kind: 'planeswalk', id: sel.id, q, r }, 'The Planeswalker steps between worlds.');
            setMode('move');
            return;
          }
          break;
        case 'attack':
          if (u && u.faction !== my && attackTargets(g, sel).some((c) => c.q === q && c.r === r)) {
            trySend({ kind: 'attack', id: sel.id, q, r });
            setMode('idle');
            setHover(null);
            return;
          }
          break;
        case 'shift':
          if (shiftTargets(g, sel).some((s) => s.q === q && s.r === r)) {
            trySend({ kind: 'shift', id: sel.id, q, r }, 'The Source bends to your will — it pays out next turn.');
            setMode('idle');
            return;
          }
          break;
        case 'heal':
        case 'wound': {
          if (u && hexDist(sel, u) <= STATS.healer.rng) {
            const want = mode === 'heal' ? u.faction === my : u.faction !== my;
            if (want) {
              trySend(
                { kind: mode, id: sel.id, targetId: u.id },
                mode === 'heal' ? 'Mended 1 life — click again to spend more mana.' : 'Wounded 1 life — click again to spend more mana.',
              );
              return;
            }
          }
          break;
        }
        case 'transloc-pick':
          if (u && u.faction === my && hexDist(sel, u) === 1) {
            setTranslocId(u.id);
            setMode('transloc-dest');
            setMsg(`Now choose where to send the ${STATS[u.type].name} — ✦${halfCost(u.type)}.`);
            return;
          }
          break;
        case 'transloc-dest':
          if (translocId != null && !u && translocateDests(g, sel).some((c) => c.q === q && c.r === r)) {
            trySend({ kind: 'translocate', id: sel.id, targetId: translocId, q, r }, 'Translocated.');
            setTranslocId(null);
            setMode('idle');
            return;
          }
          break;
        case 'banish':
          if (u && u.faction !== my && hexDist(sel, u) <= STATS.translocator.rng) {
            trySend({ kind: 'banish', id: sel.id, targetId: u.id }, 'Banished to its portal.');
            setMode('idle');
            return;
          }
          break;
      }
    }
    if (u) {
      selectUnit(u);
      return;
    }
    // clicked open ground with nothing to do there — put the unit down
    deselect();
  };

  /* ---------- overlay ---------- */

  const overlay: Overlay = useMemo(() => {
    const cells: OverlayCell[] = [];
    let line: Hex[] | undefined;
    let lineCls: string | undefined;
    let arrow = false;
    let reticle: Hex | null = null;

    if (myTurn && mode === 'summon' && summonType) {
      summonCells(g, my).forEach((c) => cells.push({ q: c.q, r: c.r, cls: 'shift shift-to' }));
    }
    if (myTurn && sel && sel.faction === my) {
      if (mode === 'move') {
        const rs = reachableCells(g, sel);
        const rKeys = new Set(rs.map(keyOf));
        rs.forEach((c) => {
          const hot = hover && hover.q === c.q && hover.r === c.r;
          cells.push({
            q: c.q,
            r: c.r,
            cls: (c.manaCost > 0 ? 'surge' : 'move') + (hot ? ' move-hot' : ''),
            label: c.manaCost > 0 ? `✦${c.manaCost}` : c.n,
          });
        });
        // faint red threat ring: hexes the unit could strike, anchored at the
        // hovered destination (move-then-attack is legal) or its current hex
        const s = STATS[sel.type];
        if (s.atk !== null && sel.attacks > 0) {
          const from: Hex = hover && rKeys.has(keyOf(hover)) ? hover : { q: sel.q, r: sel.r };
          within(map, from, s.rng).forEach((c) => {
            const d = hexDist(from, c);
            if (s.minRng && d < s.minRng) return;
            if (s.rng === 1 && !gradeOk(g, from, c)) return;
            const t = effectiveTerrain(g, c.q, c.r);
            if (!t || !PASSABLE[t]) return;
            const k = keyOf(c);
            if (rKeys.has(k) || (c.q === sel.q && c.r === sel.r)) return;
            cells.push({ q: c.q, r: c.r, cls: 'atk-range' });
          });
        }
        if (hover && rKeys.has(keyOf(hover))) {
          line = routeTo(sel, hover, rs);
          lineCls = 'move';
          arrow = true;
        }
      } else if (mode === 'planeswalk') {
        planeswalkCells(g, sel).forEach((c) =>
          cells.push({ q: c.q, r: c.r, cls: 'shift', label: `✦${c.manaCost}` }),
        );
      } else if (mode === 'attack') {
        const s = STATS[sel.type];
        const ts = attackTargets(g, sel);
        const tKeys = new Set(ts.map(keyOf));
        // faint ring of in-range hexes (respecting catapult's blind spot)
        within(map, sel, s.rng).forEach((c) => {
          const d = hexDist(sel, c);
          if (s.minRng && d < s.minRng) return;
          if (s.rng === 1) return;
          if (!tKeys.has(keyOf(c))) cells.push({ q: c.q, r: c.r, cls: 'rng-faint' });
        });
        ts.forEach((c) => {
          cells.push({
            q: c.q, r: c.r,
            cls: 'atk' + (hover && hover.q === c.q && hover.r === c.r ? ' atk-sel' : ''),
            label: c.manaCost > 0 ? `✦${c.manaCost}` : undefined,
          });
        });
        if (hover && tKeys.has(keyOf(hover))) {
          reticle = hover;
          line = [{ q: sel.q, r: sel.r }, hover];
          lineCls = sel.type === 'catapult' ? 'lob' : 'atk';
          arrow = true;
          if (sel.type === 'catapult') {
            within(map, hover, 1).forEach((c) => cells.push({ q: c.q, r: c.r, cls: 'splash' }));
          }
        }
      } else if (mode === 'shift') {
        shiftTargets(g, sel).forEach((s) => cells.push({ q: s.q, r: s.r, cls: 'shift shift-to' }));
      } else if (mode === 'heal' || mode === 'wound') {
        within(map, sel, STATS.healer.rng).forEach((c) => {
          const u = unitAt(g, c.q, c.r);
          const good = u && (mode === 'heal' ? u.faction === my : u.faction !== my);
          cells.push({ q: c.q, r: c.r, cls: good ? (mode === 'heal' ? 'heal heal-on' : 'atk') : 'heal' });
        });
        if (mode === 'heal' && sel.hp < STATS[sel.type].life) {
          cells.push({ q: sel.q, r: sel.r, cls: 'heal heal-on' });
        }
      } else if (mode === 'transloc-pick') {
        within(map, sel, 1).forEach((c) => {
          const u = unitAt(g, c.q, c.r);
          if (u && u.faction === my) cells.push({ q: c.q, r: c.r, cls: 'guard guard-on', label: `✦${halfCost(u.type)}` });
        });
      } else if (mode === 'transloc-dest') {
        translocateDests(g, sel).forEach((c) => cells.push({ q: c.q, r: c.r, cls: 'shift shift-to' }));
        if (translocId != null) {
          const t = g.units.find((u) => u.id === translocId);
          if (t) cells.push({ q: t.q, r: t.r, cls: 'shift shift-from' });
        }
      } else if (mode === 'banish') {
        within(map, sel, STATS.translocator.rng).forEach((c) => {
          const u = unitAt(g, c.q, c.r);
          if (u && u.faction !== my) cells.push({ q: c.q, r: c.r, cls: 'atk', label: `✦${halfCost(u.type)}` });
        });
      }
    }
    if (sel && sel.faction !== my) {
      cells.push({ q: sel.q, r: sel.r, cls: 'inspect' });
    }
    // a selected Defender shows its guard aura — allies inside glow shielded
    if (sel?.type === 'defender') {
      within(map, sel, 1).forEach((c) => {
        const u = unitAt(g, c.q, c.r);
        cells.push({ q: c.q, r: c.r, cls: u && u.faction === sel.faction ? 'guard guard-on' : 'guard' });
      });
    }
    return { cells, line, lineCls, arrow, reticle };
  }, [g, map, sel, mode, hover, myTurn, my, summonType, translocId]);

  /* ---------- readiness: what can still act this turn ---------- */

  const readyIds = useMemo(
    () => (myTurn ? g.units.filter((u) => u.faction === my && unitCanAct(g, u)).map((u) => u.id) : []),
    [g, my, myTurn],
  );
  const readySet = useMemo(() => new Set(readyIds), [readyIds]);
  const summonOpen = myTurn && canSummon(g);
  const nothingLeft = myTurn && readyIds.length === 0 && !summonOpen;

  const cycleReady = () => {
    if (!readyIds.length) return;
    const i = selId != null ? readyIds.indexOf(selId) : -1;
    const next = g.units.find((u) => u.id === readyIds[(i + 1) % readyIds.length]);
    if (next) selectUnit(next);
  };

  /* ---------- card ---------- */

  const units: DisplayUnit[] = g.units.map((u) => ({
    id: u.id, q: u.q, r: u.r, type: u.type, faction: u.faction,
    hp: u.hp, maxHp: STATS[u.type].life,
    sel: sel?.id === u.id,
    spent: myTurn && u.faction === my && !readySet.has(u.id),
    guarded: defenderAura(g, u) > 0,
  }));

  const tip: Tip | null =
    hover && !sel
      ? (() => {
          const u = unitAt(g, hover.q, hover.r);
          if (!u || u.faction === my) return null;
          const s = STATS[u.type];
          const aura = defenderAura(g, u);
          return {
            q: u.q, r: u.r, faction: u.faction, name: s.name,
            stats: [
              ['LIFE', u.hp + '/' + s.life],
              ['ATK', s.atk ?? '—'],
              ['DEF', aura ? `${s.def}+${aura}` : s.def],
              ['RNG', s.rng],
            ],
            note: aura ? `${s.special} · guarded by a Defender` : s.special,
          } as Tip;
        })()
      : null;

  let card = null;
  let actions: CardAction[] | null = null;
  if (sel) {
    const s = STATS[sel.type];
    const aura = defenderAura(g, sel);
    card = {
      type: sel.type,
      faction: sel.faction,
      name: s.name,
      sub: sel.faction === my ? (hotseat ? FACTION_NAME[sel.faction] + ' · selected' : 'your unit · selected') : 'enemy · scouting',
      stats: [
        ['MOV', sel.faction === my && myTurn ? `${sel.movePts}` : `${s.move}`],
        ['LIFE', `${sel.hp}/${s.life}`],
        ['ATK', s.atk === null ? '—' : `${s.atk}`],
        ['DEF', aura ? `${s.def}+${aura}` : `${s.def}`],
        ['RNG', `${s.rng}`],
      ] as Array<[string, string]>,
      special: aura ? <>{s.special} <i>· guarded: +{aura} DEF from an adjacent Defender</i></> : s.special,
      spLabel: s.spLabel,
    };
    if (sel.faction === my && myTurn) {
      const canMove = sel.moveActs > 0 && !sel.moveLocked && (sel.movePts > 0 || (sel.type === 'swordsman' && g.mana[my] > 0));
      actions = [
        { label: 'Move', active: mode === 'move', disabled: !canMove, onClick: () => { setMode('move'); setMsg('Pick a glowing hex — numbers count the steps.'); } },
      ];
      if (sel.type === 'planeswalker') {
        actions.push({
          label: 'Walk ✦',
          active: mode === 'planeswalk',
          disabled: sel.moveActs <= 0 || sel.moveLocked || g.mana[my] < 1,
          onClick: () => { setMode('planeswalk'); setMsg('Planeswalk — ✦1 per hex, over water and peaks alike.'); },
        });
      }
      if (s.atk !== null) {
        actions.push({
          label: 'Attack',
          active: mode === 'attack',
          disabled: sel.attacks <= 0 || attackTargets(g, sel).length === 0,
          onClick: () => { setMode('attack'); setMsg('Choose a foe in range.'); },
        });
        actions.push({
          label: 'Shift',
          active: mode === 'shift',
          disabled: sel.attacks <= 0 || shiftTargets(g, sel).length === 0,
          onClick: () => { setMode('shift'); setMsg('Shift an adjacent Source to your side (attack-equivalent).'); },
        });
      }
      if (sel.type === 'healer') {
        const locked = sel.abilityLock;
        actions.push({
          label: 'Mend',
          active: mode === 'heal',
          disabled: g.mana[my] < 1 || (locked ? locked.kind !== 'heal' : sel.attacks <= 0),
          onClick: () => { setMode('heal'); setMsg('Mend — click an ally, 1 life per ✦1, as often as you can pay.'); },
        });
        actions.push({
          label: 'Wound',
          active: mode === 'wound',
          disabled: g.mana[my] < 1 || (locked ? locked.kind !== 'wound' : sel.attacks <= 0),
          onClick: () => { setMode('wound'); setMsg('Wound — click a foe, 1 life per ✦1.'); },
        });
      }
      if (sel.type === 'translocator') {
        actions.push({
          label: 'Transloc.',
          active: mode === 'transloc-pick' || mode === 'transloc-dest',
          disabled: sel.attacks <= 0,
          onClick: () => { setMode('transloc-pick'); setTranslocId(null); setMsg('Pick an ally standing beside the Translocator.'); },
        });
        actions.push({
          label: 'Banish',
          active: mode === 'banish',
          disabled: sel.attacks <= 0,
          onClick: () => { setMode('banish'); setMsg('Banish a nearby foe back to its portal — ✦ half its cost.'); },
        });
      }
    }
  }

  /* ---------- objective pill ---------- */

  const srcA = g.sources.filter((s) => s.owner === 'a').length;
  const srcB = g.sources.filter((s) => s.owner === 'b').length;
  const neutral = g.sources.length - srcA - srcB;

  const youLabel = hotseat ? FACTION_NAME[my] : 'You';

  const turnLabel = g.winner
    ? 'The war is over'
    : myTurn
      ? hotseat ? FACTION_NAME[g.turn] + "'s Turn" : 'Your Turn'
      : "Opponent's Turn";

  const subLabel =
    g.mode === 'control'
      ? `turn ${g.turnNum} · control all sources 3 turns`
      : g.mode === 'gathering'
        ? `turn ${g.turnNum} · gather ✦${g.goalMana}`
        : `turn ${g.turnNum} · annihilate the enemy`;

  return (
    <Screen className="battle play" label="Battle">
      <Board
        map={map}
        units={units}
        sources={g.sources}
        battleMode={g.mode === 'battle'}
        overlay={overlay}
        tip={tip}
        onCell={onCell}
        onCellEnter={(q, r) => setHover({ q, r })}
        onCellLeave={() => setHover(null)}
      />

      <TopBar
        turn={{ faction: g.turn, label: turnLabel, sub: subLabel }}
        mana={{ n: g.mana[my], sub: g.mode === 'battle' ? 'mana · banked' : `mana · +${g.sources.filter((s) => s.owner === my).length} / turn` }}
      />

      <div className="obj-pill">
        {g.mode === 'battle' ? (
          <>
            <span className="obj-l">Armies</span>
            <span className="obj-c fa">{FACTION_NAME.a} {g.units.filter((u) => u.faction === 'a').length}</span>
            <span className="obj-c fb">{FACTION_NAME.b} {g.units.filter((u) => u.faction === 'b').length}</span>
          </>
        ) : g.mode === 'gathering' ? (
          <>
            <span className="obj-l">Gather ✦{g.goalMana}</span>
            <span className="obj-c fa">✦{g.mana.a}</span>
            <span className="obj-c fb">✦{g.mana.b}</span>
            {g.gatherExtra && <span className="obj-hold">final turn!</span>}
          </>
        ) : (
          <>
            <span className="obj-l">Sources</span>
            <span className="obj-c fa">{srcA}</span>
            <span className="obj-c fb">{srcB}</span>
            <span className="obj-c fn">{neutral}</span>
            <span className="obj-hold">
              control {g.control.a > 0 || g.pendingControl === 'a' ? `${youLabel === 'You' && my === 'a' ? 'you' : FACTION_NAME.a} ${g.control.a}/3` : g.control.b > 0 || g.pendingControl === 'b' ? `${FACTION_NAME.b} ${g.control.b}/3` : '0/3'}
            </span>
          </>
        )}
      </div>

      {card && <UnitCard unit={card} actions={actions} />}
      {combat && (
        <CombatPanel
          a={combat.attacker}
          b={combat.defender}
          result={
            combat.dmg > 0 ? (
              <span>
                a hit! — {combat.defender.name} loses <b>{combat.dmg}</b>
                {combat.splash.length > 0 && <> · splash on {combat.splash.join(', ')}</>}
                {combat.killed.length > 0 && <> · <b>{combat.killed.join(', ')} falls</b></>}
              </span>
            ) : (
              <span>blocked — the blow glances off{combat.splash.length > 0 && <> · splash on {combat.splash.join(', ')}</>}{combat.killed.length > 0 && <> · <b>{combat.killed.join(', ')} falls</b></>}</span>
            )
          }
        />
      )}
      {myTurn && (nothingLeft ? (
        <div className="wc-panel hint-card play-msg">
          <span className="hint-k urgent">turn {g.turnNum} · {hotseat ? FACTION_NAME[my] : 'you'}</span>
          Nothing left to command — <i>end your turn.</i>
        </div>
      ) : msg ? (
        <div className="wc-panel hint-card play-msg">
          <span className="hint-k">turn {g.turnNum} · {hotseat ? FACTION_NAME[my] : 'you'}</span>
          {msg}
        </div>
      ) : null)}
      {!myTurn && toast && (
        <div className="wc-panel hint-card play-msg">
          <span className="hint-k">turn {g.turnNum} · rival</span>
          {toast}
        </div>
      )}

      {showLog && (
        <div className="wc-panel log-panel">
          <div className="log-head">
            <span className="hint-k">battle log</span>
            <button className="log-close" onClick={() => setShowLog(false)}>×</button>
          </div>
          <div className="log-list">
            {g.log.length === 0 && <div className="log-empty">nothing has happened yet</div>}
            {[...g.log].reverse().map((e, i) => (
              <div key={g.log.length - i} className={'log-entry' + (e.kind === 'turn' ? ' turn' : '')}>
                <span className={'wc-dot f' + e.f}></span>
                <span className="log-text">
                  {e.kind === 'turn' || e.kind === 'resign'
                    ? `${FACTION_NAME[e.f]} ${e.text} (turn ${e.t})`
                    : e.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <SummonDock
        mana={g.mana[my]}
        activeType={summonType}
        disabledAll={!myTurn || g.actedThisTurn}
        dim={myTurn && !summonOpen}
        note={g.actedThisTurn ? 'portal closed' : undefined}
        onPick={(t) => {
          setSummonType(t);
          setSelId(null);
          setMode('summon');
          setMsg(`Place the ${STATS[t].name} on a free portal hex.`);
        }}
      />
      {myTurn && readyIds.length > 0 && (
        <button className="ready-counter" onClick={cycleReady} title="Jump to the next unit that can still act">
          <span className="rc-dot"></span>
          <span className="rc-n">{readyIds.length}</span>
          <span>still ready</span>
          <span className="rc-arrow">→</span>
        </button>
      )}
      <button
        className={'endturn-btn' + (nothingLeft ? ' glow' : '')}
        disabled={!myTurn}
        onClick={() => trySend({ kind: 'endTurn' })}
      >
        End Turn →
      </button>
      <button className="resign-btn" onClick={onResign}>Resign</button>
      <button className={'log-btn' + (showLog ? ' on' : '')} onClick={() => setShowLog((s) => !s)}>
        ☰ Log
      </button>

      {!myTurn && !g.winner && !g.draw && (
        <div className="turn-banner banner-fade" key={turnKey}>
          <div className={'tb-crest f' + g.turn}></div>
          <div className="tb-line">Opponent&rsquo;s Turn</div>
          <div className="tb-sub">
            {FACTION_NAME[g.turn]} is plotting<span className="dots"><i>.</i><i>.</i><i>.</i></span>
          </div>
        </div>
      )}
    </Screen>
  );
}
