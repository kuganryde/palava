import { BUILDING_DEFS } from '../core/defs';
import { buildingHp, buildingTeam, isAlive, teamOf, workersOnSite, type GameState } from '../core/state';

/**
 * Story beats: short captions that fire once per game when a milestone is reached. Pure functions of the
 * game state, so they are deterministic, testable and saved simply as the list of ids already shown.
 * All text is fiction, written for the game; nothing here claims to be history.
 */
export interface Beat {
  id: string;
  title: string;
  text: string;
  /** True once the milestone has been reached. */
  test(s: GameState): boolean;
}

const MARCH_DISTANCE = 45;

function staffedSlots(s: GameState): number {
  let n = 0;
  for (const b of s.buildings) {
    const slots = BUILDING_DEFS[b.type].slots;
    if (slots > 0 && b.progress >= 1 && buildingTeam(b) === 0) n += Math.min(slots, workersOnSite(s, b));
  }
  return n;
}

function armyFarFromHome(s: GameState): boolean {
  const palace = s.buildings.find((b) => b.type === 'palace');
  if (!palace) return false;
  const d = BUILDING_DEFS.palace;
  const cx = palace.x0 + d.w / 2, cz = palace.z0 + d.d / 2;
  return s.units.some((u) => isAlive(u) && teamOf(u) === 0 && u.kind !== 'villager' && Math.hypot(u.x - cx, u.z - cz) > MARCH_DISTANCE);
}

export const BEATS: readonly Beat[] = [
  {
    id: 'founding', title: 'The First Stone',
    text: 'The first stone of the new city is set, and the river carries word of it to the sea. Let the masons sing.',
    test: (s) => s.buildings.some((b) => b.type !== 'palace' && buildingTeam(b) === 0 && b.progress >= 1),
  },
  {
    id: 'harvest', title: 'The Granary Hums',
    text: 'Hands at the plough, hands at the axe. For the first time the labour of your people feeds the kingdom.',
    test: (s) => staffedSlots(s) >= 3,
  },
  {
    id: 'raid', title: 'Smoke on the Hills',
    text: 'Horns echo along the ridge. A rival banner comes down upon your fields: the first raid has begun.',
    test: (s) => (s.ai?.wave ?? 0) >= 1,
  },
  {
    id: 'standing', title: 'The Banner Holds',
    text: 'The raiders break and scatter. Your people rebuild by lamplight, and the kingdom remembers who stood.',
    test: (s) => !!s.ai && s.ai.wave >= 1 && s.ai.raid.length === 0,
  },
  {
    id: 'march', title: 'The Long March',
    text: 'Your army leaves the walls behind. Ahead lies the rival\'s country, and no road home but victory.',
    test: armyFarFromHome,
  },
  {
    id: 'siege', title: 'The Wall Trembles',
    text: 'Stone groans under the blows. The rival stronghold is wounded: press on before the drums call help.',
    test: (s) => s.buildings.some((b) => b.type === 'stronghold' && buildingHp(b) < BUILDING_DEFS.stronghold.hp),
  },
  {
    id: 'victory', title: 'The Kingdom Endures',
    text: 'The rival banner falls and the hills fall quiet. Songs of this day will outlast the stone you raised.',
    test: (s) => s.outcome === 'victory',
  },
  {
    id: 'fall', title: 'Ash and Memory',
    text: 'The palace burns, but a kingdom is more than its halls. Some day another ruler will raise this city again.',
    test: (s) => s.outcome === 'defeat',
  },
];

const KNOWN = new Set(BEATS.map((b) => b.id));
export const isBeatId = (id: unknown): id is string => typeof id === 'string' && KNOWN.has(id);
export const beatById = (id: string): Beat | undefined => BEATS.find((b) => b.id === id);

/** Beats that have newly come true. The caller records them in `state.story`. */
export function newBeats(s: GameState): Beat[] {
  const seen = new Set(s.story ?? []);
  return BEATS.filter((b) => !seen.has(b.id) && b.test(s));
}

/** Record beats as shown (idempotent). */
export function markSeen(s: GameState, beats: readonly Beat[]): void {
  const seen = s.story ?? (s.story = []);
  for (const b of beats) if (!seen.includes(b.id)) seen.push(b.id);
}
