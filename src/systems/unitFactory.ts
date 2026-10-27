import { UNIT_DEFS, type UnitKind } from '../core/defs';
import type { GameState, Team, UnitState } from '../core/state';

export function makeUnit(state: GameState, kind: UnitKind, x: number, z: number, team: Team = 0): UnitState {
  return {
    id: state.nextId++, kind, x, z, px: x, pz: z, facing: 0,
    hp: UNIT_DEFS[kind].hp, path: [], team, target: null, cooldown: 0, repath: 0, scan: 0,
  };
}
