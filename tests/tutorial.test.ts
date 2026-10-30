import { describe, expect, it } from 'vitest';
import { STEPS, advance, isComplete, parseHint, type TutorialProbe } from '../src/story/tutorial';

const none: TutorialProbe = { selectedFighters: 0, moved: false, farms: 0, staffed: 0, barracks: 0, recruited: false };

describe('tutorial', () => {
  it('has unique ids and short hints for both input types', () => {
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
    for (const s of STEPS) for (const touch of [false, true]) {
      expect(s.hint(touch).length).toBeGreaterThan(5);
      expect(s.hint(touch).length).toBeLessThan(90);
      expect(s.hint(touch) + s.title).not.toMatch(/[<>]/);
    }
  });
  it('starts at the first step and advances one objective at a time', () => {
    expect(advance(0, none)).toBe(0);
    expect(advance(0, { ...none, selectedFighters: 2 })).toBe(1);
    expect(advance(1, { ...none, selectedFighters: 2, moved: true })).toBe(2);
  });
  it('skips ahead over steps the player already did, but never goes back', () => {
    const p = { ...none, selectedFighters: 0, moved: true, farms: 1 };
    expect(advance(0, p)).toBe(0); // still has to select: order matters
    expect(advance(1, p)).toBe(3);
    expect(advance(3, { ...none })).toBe(3);
  });
  it('completes once everything is done', () => {
    const all: TutorialProbe = { selectedFighters: 1, moved: true, farms: 1, staffed: 3, barracks: 1, recruited: true };
    expect(isComplete(advance(0, all))).toBe(true);
    expect(isComplete(2)).toBe(false);
  });
  it('splits key caps out of hints', () => {
    expect(parseHint('Press [3] or pick Farm')).toEqual([{ text: 'Press ', key: false }, { text: '3', key: true }, { text: ' or pick Farm', key: false }]);
    expect(parseHint('[Right-click] the ground')[0]).toEqual({ text: 'Right-click', key: true });
    expect(parseHint('plain')).toEqual([{ text: 'plain', key: false }]);
  });
});
