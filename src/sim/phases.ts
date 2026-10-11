import { signalConflict } from './conflicts';
import { DIRS, axisOf, type Axis, type Dir, type Maneuver } from './geometry';
import { PATHS } from './routes';

/**
 * Светофорные фазы. В каждой фазе маршрут получает статус:
 *  'P' — защищённый (зелёная стрелка / приоритет), 'Y' — разрешённый с уступкой
 *  (зелёный круг: уступить защищённым конфликтующим потокам). Отсутствие — красный.
 */
export type MoveStatus = 'P' | 'Y';
export type LeftMode = 'permissive' | 'protected';

export interface Phase {
  id: string;
  label: string;
  axis: Axis;
  kind: 'through' | 'left';
  status: Map<string, MoveStatus>;
}

export type UturnAllowed = Record<Dir, boolean>;
export const NO_UTURNS: UturnAllowed = { N: false, E: false, S: false, W: false };

function pathsOf(dirs: Dir[], mans: Maneuver[], uturn: UturnAllowed): string[] {
  const out: string[] = [];
  for (const m of mans)
    for (const p of PATHS.values())
      if (p.man === m && dirs.includes(p.dir) && (m !== 'U' || uturn[p.dir])) out.push(p.id);
  return out;
}

/** Добавляет маршруты в фазу: защищённый, если не конфликтует с уже защищёнными, иначе — уступающий. */
function assign(phase: Phase, ids: string[], allowProtected: boolean): void {
  for (const id of ids) {
    const prot = [...phase.status].filter(([, s]) => s === 'P').map(([k]) => k);
    const ok = allowProtected && prot.every((o) => !signalConflict(id, o));
    phase.status.set(id, ok ? 'P' : 'Y');
  }
}

export function buildPlan(mode: LeftMode, uturn: UturnAllowed): Phase[] {
  const axes: [Axis, Dir[]][] = [['NS', ['N', 'S']], ['EW', ['E', 'W']]];
  const phases: Phase[] = [];
  for (const [axis, dirs] of axes) {
    const name = axis === 'NS' ? 'С–Ю' : 'В–З';
    if (mode === 'permissive') {
      const ph: Phase = { id: axis, label: name, axis, kind: 'through', status: new Map() };
      assign(ph, pathsOf(dirs, ['T', 'R'], uturn), true);
      assign(ph, pathsOf(dirs, ['L', 'U'], uturn), false); // налево и разворот уступают встречным
      phases.push(ph);
    } else {
      const left: Phase = { id: `${axis}-L`, label: `${name} налево`, axis, kind: 'left', status: new Map() };
      assign(left, pathsOf(dirs, ['L'], uturn), true);
      assign(left, pathsOf(dirs, ['U'], uturn), true);
      const thr: Phase = { id: `${axis}-T`, label: `${name} прямо`, axis, kind: 'through', status: new Map() };
      assign(thr, pathsOf(dirs, ['T', 'R'], uturn), true);
      phases.push(left, thr);
    }
  }
  return phases;
}

/** Проверка плана: никакие два защищённых конфликтующих маршрута не открыты одновременно. */
export function validatePlan(phases: Phase[]): string[] {
  const errs: string[] = [];
  for (const ph of phases) {
    const prot = [...ph.status].filter(([, s]) => s === 'P').map(([k]) => k);
    for (let i = 0; i < prot.length; i++)
      for (let j = i + 1; j < prot.length; j++)
        if (signalConflict(prot[i], prot[j])) errs.push(`${ph.id}: ${prot[i]} и ${prot[j]} конфликтуют`);
    for (const id of ph.status.keys()) if (axisOf(PATHS.get(id)!.dir) !== ph.axis) errs.push(`${ph.id}: чужая ось ${id}`);
  }
  return errs;
}

/** Каждый допустимый маршрут обслуживается хотя бы одной фазой. */
export function unservedMovements(phases: Phase[], uturn: UturnAllowed): string[] {
  const served = new Set(phases.flatMap((p) => [...p.status.keys()]));
  return [...PATHS.values()].filter((p) => (p.man !== 'U' || uturn[p.dir]) && !served.has(p.id)).map((p) => p.id);
}

export { DIRS };
