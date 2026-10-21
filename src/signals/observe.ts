/**
 * Наблюдения городского светофора по фазам из демо-трафика (синтетика): очередь, подъезжающие, ожидание.
 * Пешеходов в демо-модели нет, поэтому у виртуальной пешеходной фазы спрос предполагается всегда
 * (approaching = 1), а «ожидание» — время с её последнего зелёного: она обслуживается по давлению или по максимуму.
 */
import type { PhaseObs } from '../sim/controllers';
import type { ApproachObs } from '../traffic/fleet';
import { arcKey, type SignalItem } from './system';

export function legObs(it: SignalItem, leg: number, obs: Map<number, ApproachObs>): ApproachObs {
  const out = { queue: 0, approaching: 0, maxWait: 0 };
  for (const d of it.site.legs[leg].inbound) {
    const o = obs.get(arcKey(d.edge, d.forward));
    if (!o) continue;
    out.queue += o.queue;
    out.approaching += o.approaching;
    out.maxWait = Math.max(out.maxWait, o.maxWait);
  }
  return out;
}

export function cityObserve(it: SignalItem, obs: Map<number, ApproachObs>, _t: number): PhaseObs[] {
  return it.groups.map((g, k) => {
    if (g.pedestrian) return { queue: 0, approaching: 1, maxWait: it.rt ? it.rt.sinceGreen(k) : 0 };
    const out = { queue: 0, approaching: 0, maxWait: 0 };
    for (const li of g.legs) {
      const o = legObs(it, li, obs);
      out.queue += o.queue;
      out.approaching += o.approaching;
      out.maxWait = Math.max(out.maxWait, o.maxWait);
    }
    return out;
  });
}
