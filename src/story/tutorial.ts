/**
 * Guided first minutes: a short sequence of objectives shown while the player plays (never a separate
 * screen, always skippable). Progress is a pure function of a small snapshot of the game, so it is
 * deterministic and testable; the game only has to fill in the snapshot.
 */
export interface TutorialProbe {
  /** Selected player units that are not villagers. */
  selectedFighters: number;
  /** The player has ordered a move, attack or attack-move at least once. */
  moved: boolean;
  /** Finished or started farms owned by the player. */
  farms: number;
  /** Worker slots currently staffed. */
  staffed: number;
  /** Finished barracks. */
  barracks: number;
  /** The player has trained at least one unit. */
  recruited: boolean;
}

export interface TutorialStep {
  id: string;
  title: string;
  /** Short, visual-first hint. Keys appear inside [brackets] and are drawn as key caps. */
  hint(touch: boolean): string;
  done(p: TutorialProbe): boolean;
}

export const STEPS: readonly TutorialStep[] = [
  {
    id: 'select', title: 'Select your warriors',
    hint: (t) => (t ? 'Tap a warrior, or drag to box-select' : 'Click a warrior, or drag a box around several'),
    done: (p) => p.selectedFighters > 0,
  },
  {
    id: 'move', title: 'Send them somewhere',
    hint: (t) => (t ? 'Tap the ground to move them' : '[Right-click] the ground to move them'),
    done: (p) => p.moved,
  },
  {
    id: 'farm', title: 'Build a Farm',
    hint: (t) => (t ? 'Pick Farm in the bottom bar, then tap to place it' : 'Press [3] or pick Farm, then click to place it'),
    done: (p) => p.farms > 0,
  },
  {
    id: 'workers', title: 'Villagers work by themselves',
    hint: () => 'Idle villagers staff the farm once it is built. Watch the Workers counter',
    done: (p) => p.staffed > 0,
  },
  {
    id: 'barracks', title: 'Build a Barracks',
    hint: (t) => (t ? 'Pick Barracks, then tap to place it' : 'Press [2], then click to place it'),
    done: (p) => p.barracks > 0,
  },
  {
    id: 'recruit', title: 'Train a warrior',
    hint: (t) => (t ? 'Tap the Barracks, then Recruit' : 'Click the Barracks, then Recruit'),
    done: (p) => p.recruited,
  },
];

/** The index of the first step not yet done, starting from `from` (steps never go backwards). */
export function advance(from: number, p: TutorialProbe): number {
  let i = Math.max(0, from);
  while (i < STEPS.length && STEPS[i]!.done(p)) i++;
  return i;
}

export const isComplete = (index: number): boolean => index >= STEPS.length;

/** Split a hint into plain text and key-cap runs: "Press [3] now" -> text, key, text. */
export function parseHint(hint: string): Array<{ text: string; key: boolean }> {
  const out: Array<{ text: string; key: boolean }> = [];
  for (const part of hint.split(/(\[[^\]]+\])/)) {
    if (!part) continue;
    out.push(part.startsWith('[') ? { text: part.slice(1, -1), key: true } : { text: part, key: false });
  }
  return out;
}
