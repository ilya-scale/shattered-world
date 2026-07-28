// The battlefields. Two maps:
//
//  - "Sundered Isle"  — the compact flat-top island designed for quick games.
//  - "World of Amphis" — the sample map from Rules.docx, extracted hex-by-hex
//    from the rulebook image (terrain, the 9 marked mana sources and both
//    7-hex summoning portals). Ramps and bridges were added where the
//    elevation rules would otherwise wall off regions the original clearly
//    meant to be playable.

import { hexKey, type Hex } from './hex';
import type { Faction, Terrain } from './data';

export type MapId = 'isle' | 'amphis' | 'shards' | 'spine';

export interface MapDef {
  id: MapId;
  name: string;
  blurb: string;
  /** hex orientation: 'flat' = flat-top (design default), 'pointy' = rulebook map */
  orient: 'flat' | 'pointy';
  /** hex circumradius in board pixels */
  hexSize: number;
  terrain: ReadonlyMap<string, Terrain>;
  sources: Hex[];
  portals: Record<Faction, Hex[]>;
}

/* ================= Sundered Isle (radius-4, flat-top) ================= */

const ISLE_RADIUS = 4;

const ISLE_PORTALS: Record<Faction, Hex[]> = {
  a: [{ q: -4, r: 1 }, { q: -4, r: 2 }, { q: -4, r: 3 }],
  b: [{ q: 4, r: -1 }, { q: 4, r: -2 }, { q: 4, r: -3 }],
};

const ISLE_SOURCES: Hex[] = [
  { q: 0, r: 0 },
  { q: 0, r: -3 }, { q: 0, r: 3 },
  { q: 3, r: -3 }, { q: -3, r: 3 },
  { q: 2, r: -1 }, { q: -2, r: 1 },
  { q: 2, r: 2 }, { q: -2, r: -2 },
];

const ISLE_PLACED: Array<[number, number, Terrain]> = [
  [1, -4, 'mountain'], [2, -4, 'mountain'], [-1, 4, 'mountain'], [-2, 4, 'mountain'],
  [1, -3, 'ramp'], [-1, 3, 'ramp'],
  [-2, 0, 'water'], [-1, -1, 'water'], [2, 0, 'water'], [1, 1, 'water'],
  [-2, -1, 'bridge'], [2, 1, 'bridge'],
  [4, 0, 'sand'], [3, 1, 'sand'], [-4, 0, 'sand'], [-3, -1, 'sand'],
  [1, -1, 'forest'], [2, -2, 'forest'], [-1, 1, 'forest'], [-2, 2, 'forest'],
];

function buildIsle(): ReadonlyMap<string, Terrain> {
  const t = new Map<string, Terrain>();
  for (let q = -ISLE_RADIUS; q <= ISLE_RADIUS; q++) {
    for (let r = -ISLE_RADIUS; r <= ISLE_RADIUS; r++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= ISLE_RADIUS) {
        t.set(hexKey(q, r), 'grass');
      }
    }
  }
  for (const [q, r, terr] of ISLE_PLACED) t.set(hexKey(q, r), terr);
  for (const s of ISLE_SOURCES) t.set(hexKey(s.q, s.r), 'source');
  for (const f of ['a', 'b'] as const) for (const p of ISLE_PORTALS[f]) t.set(hexKey(p.q, p.r), 'portal');
  return t;
}

/* ================= World of Amphis (rulebook sample map) ================= */

// Odd-r offset rows extracted from the "Sample map with pylons" image in
// Rules.docx. The map is assembled from the rulebook's ten megatiles, each
// placed twice at 180°-mirrored positions, which was used to verify the
// extraction: classification votes are pooled with each hex's rotational
// twin, the nine pylon (mana source) markers and both 7-hex portals were
// located by their drawn markers, and the ramps/bridges are the ones drawn
// in the image (olive ramp tiles and brown bridge spans, all in symmetric
// pairs). Every source is shiftable and both portals connect.
//
// The extraction was then made exactly 180°-symmetric (rotation p -> S-p
// about the board centre, portals mapping A<->B): eight fringe hexes that
// lacked a rotational twin were paired up or dropped, and eleven twin
// PAIRS of ramps/bridges were added to open the walled-off low-ground
// pockets, giving each base three distinct lanes out (the old main road, a
// mountain flank lane behind each base, and a coastal through-lane across
// the water strips at rows 22/(15,4)-(10,8) and their mirrors). Every
// low-ground region except one decorative 1-hex nook per side is now
// reachable from both portals, and the reachable set is itself symmetric.
// . void · g grass · w water · s sand · f rainforest · m mountains
// d desert mountains · r ramp · b bridge · o mana source · A/B portals
const AMPHIS_ROWS: string[] = [
  '...................ww......gg',
  '..........mg......www..gmmfrg',
  '..........mrg...ggwwww.ggmmmogww',
  '.......omfgwwmmgggwwwrgmggmgwwww',
  '.......ggggwwggmgggwwgwgmgmmbwwm',
  '.......mgfwwgggwbwrwwbwmgwwbwgm',
  '.......mggwwggmwrgwbwgwwwbwmmgf...BB',
  '.......gggwwgmggggwgggwwwggmfgg..BBB',
  '.......gwwbggggggwwwwggggggrmmggrgBBg',
  '.......wgwfgmggsswwwggggggggmwmmmggg',
  '.......gbgggmdgssswwgggmmgggmmmmrmmw',
  '....gggwwgmdsssssdmggmgfgmmsmmmgrmmw',
  '....gggwwgmmssssdmmfgggmmmdswggmmmmg',
  '...gggwgfmmdsmmdmmgggfmmdsdsgmmmgfg',
  '....gwwgfmssmmmmmgggggmmrsssgmfgfrmw',
  '...wbggfmsommmmggggggmmssdswgmmgmmmmg',
  '...ggggmmsssfggggggmmmsddddssdfmmmwmgw',
  '...gggmsssssggggggfssssdssssdsrmmggrgw',
  '....gggmsssssdmggddsssssssddsdsggmmmggwmm',
  '...ggwmssddsddmmssssssssddddddddgmgbbwmm',
  '.gggggwmddddsdsdssssssssssddsdssdggwgwmfm',
  'gmgggwwmddddddddsssfgssssddsrddsgmmgowfg',
  '.mrwbwmmmddsssdsdssfofssdsdsssddmmmwbwrm',
  'gfwogmmgsddrsddssssgfsssddddddddmwwgggmg',
  'mfmwgwggdssdsddssssssssssdsdsddddmwggggg',
  'mmwbbgmgddddddddssssssssmmddsddssmwgg',
  'mmwggmmmggsdsddsssssssddggmdsssssmggg',
  '..wgrggmmrsdssssdssssfggggggsssssmggg',
  '...wgmwmmmfdssddddsmmmggggggfsssmmgggg',
  '...gmmmmgmmgwsdssmmggggggmmmmosmfggbw',
  '.....wmrfgfmgsssrmmgggggmmmmmssmfgwwg',
  '.....gfgmmmgsdsdmmfgggmmdmmsdmmfgwggg',
  '.....gmmmmggwsdmmmgggfmmdssssmmgwwggg',
  '....wmmrgmmmsmmgfgmggmdsssssdmgwwggg',
  '.....wmmrmmmmgggmmgggwwsssgdmgggbg',
  '....gggmmmwmggggggggwwwssggmgfwgw',
  '....gAAgrggmmrggggggwwwwggggggbwwg',
  '....AAA..ggfmggwwwgggwggggmgwwggg',
  '.....AA...fgmmwbwwwgwbwgrwmggwwggm',
  '.........mgwbwwgmwbwwrwbwgggwwfgm',
  '.........mwwbmmgmgwgwwgggmggwwgggg',
  '........wwwwgmggmgrwwwgggmmwwgfmo',
  '.........wwgommmgg.wwwwgg...grm',
  '...........grfmmg..www......gm',
  '............gg......ww',
];

const AMPHIS_CHAR: Record<string, Terrain> = {
  g: 'grass', w: 'water', s: 'sand', f: 'forest', m: 'mountain',
  d: 'desert', r: 'ramp', b: 'bridge', o: 'source', A: 'portal', B: 'portal',
};

/** odd-r offset → axial */
function oddrToAxial(col: number, row: number): Hex {
  return { q: col - ((row - (row & 1)) / 2), r: row };
}

function buildRows(rows: string[]): { terrain: ReadonlyMap<string, Terrain>; sources: Hex[]; portals: Record<Faction, Hex[]> } {
  const terrain = new Map<string, Terrain>();
  const sources: Hex[] = [];
  const portals: Record<Faction, Hex[]> = { a: [], b: [] };
  rows.forEach((line, row) => {
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch === '.') continue;
      const t = AMPHIS_CHAR[ch];
      if (!t) continue;
      const h = oddrToAxial(col, row);
      terrain.set(hexKey(h.q, h.r), t);
      if (ch === 'o') sources.push(h);
      if (ch === 'A') portals.a.push(h);
      if (ch === 'B') portals.b.push(h);
    }
  });
  return { terrain, sources, portals };
}


/* ============ The Shardsea (generated, 180°-symmetric) ============ */
// An archipelago on the Amphis silhouette: a hub isle ringed by six shards,
// joined by bridge lanes. Mountain crowns and desert knuckles guard the
// flanking sources; every island heart holds a pylon.
const SHARDS_ROWS: string[] = [
  '...................ww......ww',
  '..........ww......www..wwwwww',
  '..........www...wwwwww.wwwwwwwww',
  '.......wwwwwwwwwwwwwwwwwwwwwwwww',
  '.......wwwwwwwwwwwwwwwwwwwwwwwww',
  '.......wwwwwwwwwwwwwwwwwwwwwwww',
  '........wwwwwwwwwwwwwwwwwwwwwwwo..BB',
  '.......wwwwwwwwwwwwwwwwwwwwwwwg..BBB',
  '.......wwwwwwwwwwwssssswwwwwwwwsggBBg',
  '.......wwwwwwwwwwgfgggswwwssssgfgggg',
  '.......wwwwwwwwwwsfgffgfwwsggggggfgg',
  '....wwwwwwwwwwwwgggmmggswsfggfgfggfg',
  '....wwwwwwwwwwwwgggmomggfsgggggggwww',
  '...wwwwwwwwwwwwwsgfrmggsgggfogfggww',
  '....wwwwwwwwwwwwwsggfggsbgfgggffswww',
  '...wwwsggsgwwwwwwgggggsbwgggggggwwwww',
  '...wwwggggggwwwwwggfggfswwggfggswwwwww',
  '...wwsddfgggwwwwsfgggfggwwfggfswwwwwww',
  '....wgdodggfgwwwsggggfgggwwwwbwwwwwwwwwww',
  '...wsgddrggfswwsfgggggfggwwwbwwwwwwwwwwww',
  '.wwwwgggggggswwsgfgggggggswwbwwwwwwwwwwww',
  'wwwwwgggffggbbggggfggfgffswbwgsfggwwwwww',
  '.wwwwwgggggswbsgggggogggggsbwsgggggwwwww',
  'wwwwwwggfsgwbwsffgfggfggggbbggffgggwwwww',
  'wwwwwwwwwwwwbwwsgggggggfgswwsgggggggwwww',
  'wwwwwwwwwwwbwwwggfgggggfswwsfggrddgsw',
  '.wwwwwwwwwwbwwwwgggfggggswwwgfggdodgw',
  '..wwwwwwwsfggfwwggfgggfswwwwgggfddsww',
  '...wwwwwwsggfggwwsfggfggwwwwwggggggwww',
  '....wwwwgggggggwbsgggggwwwwwwgsggswww',
  '.....wwwsffgggfgbsggfggswwwwwwwwwwwww',
  '.....wwggfgofgggsggmrfgswwwwwwwwwwwww',
  '.....wwwgggggggsfggmomgggwwwwwwwwwwww',
  '....gfggfgfggfswsggmmgggwwwwwwwwwwww',
  '.....ggfggggggswwfgffgfswwwwwwwwww',
  '....ggggfgsssswwwsgggfgwwwwwwwwww',
  '....gAAggswwwwwwwwssssswwwwwwwwwww',
  '....AAA..gwwwwwwwwwwwwwwwwwwwwwww',
  '.....AA..owwwwwwwwwwwwwwwwwwwwwwww',
  '.........wwwwwwwwwwwwwwwwwwwwwwww',
  '.........wwwwwwwwwwwwwwwwwwwwwwwww',
  '.........wwwwwwwwwwwwwwwwwwwwwwww',
  '..........wwwwwwww.wwwwww...www',
  '...........wwwwww..www......ww',
  '............ww',
];

/* ============ The Worldspine (generated, 180°-symmetric) ============ */
// A high stone caldera over open woodland. Three pylons sit inside the bowl
// behind four ramp passes; lakes, woods and highland spurs shape the plains.
const SPINE_ROWS: string[] = [
  '...................gg......gg',
  '..........gg......ggg..gggggg',
  '..........ggg...gggggg.ggggggggg',
  '.......gggggsssgggggggggggggggss',
  '.......gggggssssggggggggggggggss',
  '.......ggggsssssgggggggggggggss',
  '........ggggssssgggggwwwfffgggs...BB',
  '.......gggggssfffgggwwwwfffgggs..BBB',
  '.......gggggggffffggbbbbbfffggggggBBg',
  '.......gggwwwfffffggwwwwffffgggggggg',
  '.......gggwwwwffffgggwwwfffffggggggg',
  '....gggggbbbbbfffgggggggfffffgggsssg',
  '....ggggggwwwwmggggggggggfffowwwosss',
  '...ggggggmwwwmmggggggggggfffwwwwsss',
  '....gggggmmmmmmgggggggggggggbbbbbsss',
  '...gggggmmmmmmggggggggggggggwwwwsssgg',
  '...ggggggmomrggggdmrrrmmggggfwwwgggggg',
  '...ggggggmmmggggmmmrrdmdgggffffggggggg',
  '....ggggggggggggdmsssssmdggffffffffgggggg',
  '...ggggggggggggmdssssssmdggffffffffgggggg',
  '.ggggggggggggggdmossssssmmggffffffffggggg',
  'ggggggggggggggddssssssssdmgggggffffggggg',
  '.gggggfffgggggmdssssossssdmgggggfffggggg',
  'gggggffffgggggmdssssssssddgggggggggggggg',
  'gggggffffffffggmmssssssomdgggggggggggggg',
  'gggggffffffffggdmssssssdmgggggggggggg',
  '.gggggffffffffggdmsssssmdgggggggggggg',
  '..gggggggffffgggdmdrrmmmggggmmmgggggg',
  '...ggggggwwwfggggmmrrrmdggggrmomgggggg',
  '....gssswwwwggggggggggggggmmmmmmggggg',
  '.....sssbbbbbgggggggggggggmmmmmmggggg',
  '.....ssswwwwfffggggggggggmmwwwmgggggg',
  '.....sssowwwofffggggggggggmwwwwgggggg',
  '....gsssgggfffffgggggggfffbbbbbggggg',
  '.....gggggggfffffwwwgggffffwwwwggg',
  '....ggggggggffffwwwwggfffffwwwggg',
  '....gAAggggggfffbbbbbggffffggggggg',
  '....AAA..sgggfffwwwwgggfffssggggg',
  '.....AA...sgggfffwwwgggggssssggggg',
  '.........ssgggggggggggggsssssgggg',
  '.........ssggggggggggggggssssggggg',
  '.........sgggggggggggggggsssggggg',
  '..........gggggggg.gggggg...ggg',
  '...........gggggg..ggg......gg',
  '............gg',
];

/* ================= registry ================= */

const amphis = buildRows(AMPHIS_ROWS);
const shards = buildRows(SHARDS_ROWS);
const spine = buildRows(SPINE_ROWS);

export const MAPS: Record<MapId, MapDef> = {
  isle: {
    id: 'isle',
    name: 'Sundered Isle',
    blurb: 'a compact symmetric isle — quick, sharp duels',
    orient: 'flat',
    hexSize: 32,
    terrain: buildIsle(),
    sources: ISLE_SOURCES,
    portals: ISLE_PORTALS,
  },
  amphis: {
    id: 'amphis',
    name: 'World of Amphis',
    blurb: 'the sample map from the rulebook — a long campaign',
    orient: 'pointy',
    hexSize: 18,
    terrain: amphis.terrain,
    sources: amphis.sources,
    portals: amphis.portals,
  },
  shards: {
    id: 'shards',
    name: 'The Shardsea',
    blurb: 'bridged isles around a hub — fight for the lanes',
    orient: 'pointy',
    hexSize: 18,
    terrain: shards.terrain,
    sources: shards.sources,
    portals: shards.portals,
  },
  spine: {
    id: 'spine',
    name: 'The Worldspine',
    blurb: 'a stone caldera over open woodland — hold the passes',
    orient: 'pointy',
    hexSize: 18,
    terrain: spine.terrain,
    sources: spine.sources,
    portals: spine.portals,
  },
};

export const MAP_LIST: MapDef[] = [MAPS.isle, MAPS.amphis, MAPS.shards, MAPS.spine];

export function hexesOf(map: MapDef): Array<Hex & { t: Terrain }> {
  return [...map.terrain.entries()].map(([k, t]) => {
    const [q, r] = k.split(',').map(Number);
    return { q, r, t };
  });
}
