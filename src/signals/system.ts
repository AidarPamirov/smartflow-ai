/**
 * Городская сеть виртуальных светофоров: объекты из OSM (inventory.ts) + план (plan.ts) + работа (runtime.ts).
 * Без карты и без интерфейса: слой (signalLayer.ts) и панель (SignalPanel.tsx) только читают состояние.
 */
import type { PhaseObs } from '../sim/controllers';
import type { Network } from '../traffic/network';
import { buildInventory, type Inventory, type RawOsmSignals, type SignalSite } from './inventory';
import { fixedTiming, phaseGroups, type FixedTiming, type PhaseGroup } from './plan';
import { SignalRuntime, type ControlMode, type Light } from './runtime';

/** Зоны детальной симуляции SUMO: светофор, ближайший к центру зоны (≤ 60 м), ведёт на её страницу. */
export const SUMO_ZONES = [{ id: 'chui-manas', title: 'Чуй × Манаса', lon: 74.562291, lat: 42.877856, href: '#sumo' }];

export type ItemStatus = 'working' | 'inactive' | 'no_data';

export interface SignalItem {
  index: number;
  site: SignalSite;
  groups: PhaseGroup[];
  timing: FixedTiming;
  /** null — данных для плана нет (status no_data). */
  rt: SignalRuntime | null;
  /** Номер фазы-группы для каждого подхода site.legs; -1 — подход без въезда. */
  legGroup: number[];
  zone: (typeof SUMO_ZONES)[number] | null;
}

/** Ключ направленного участка: ребро × 2 + (0 — по направлению ребра, 1 — против). */
export const arcKey = (edge: number, forward: boolean) => edge * 2 + (forward ? 0 : 1);

export class SignalSystem {
  readonly inv: Inventory;
  readonly items: SignalItem[];
  /** Въездные участки светофоров → объект и фаза. */
  readonly byArc = new Map<number, { item: number; group: number; leg: number }>();
  t = 0;

  constructor(net: Network, osm: RawOsmSignals, t0 = 0) {
    this.inv = buildInventory(net, osm);
    this.t = t0;
    this.items = this.inv.sites.map((site, index) => {
      const groups = site.status === 'ok' ? phaseGroups(site) : [];
      const timing = fixedTiming(site, groups);
      const legGroup = site.legs.map((_, li) => groups.findIndex((g) => g.legs.includes(li)));
      const rt = groups.length >= 2 ? new SignalRuntime(groups, timing, t0) : null;
      const zone = SUMO_ZONES.find((z) => Math.hypot((z.lon - site.lon) * 81_600, (z.lat - site.lat) * 111_200) <= 60) ?? null;
      return { index, site, groups, timing, rt, legGroup, zone };
    });
    for (const it of this.items) {
      if (!it.rt) continue;
      it.site.legs.forEach((leg, li) => {
        const g = it.legGroup[li];
        if (g < 0) return;
        for (const d of leg.inbound) this.byArc.set(arcKey(d.edge, d.forward), { item: it.index, group: g, leg: li });
      });
    }
  }

  status(it: SignalItem): ItemStatus {
    if (!it.rt) return 'no_data';
    return it.rt.status === 'working' ? 'working' : 'inactive';
  }

  /** Шаг всех светофоров на dt секунд модели. observe — очереди по фазам для адаптивного режима. */
  step(dt: number, observe?: (it: SignalItem) => PhaseObs[]) {
    this.t += dt;
    for (const it of this.items) if (it.rt) it.rt.step(dt, observe ? () => observe(it) : undefined);
  }

  /** Сигнал для въездного участка; null — участок не регулируется. */
  lightForArc(key: number): Light | null {
    const r = this.byArc.get(key);
    if (!r) return null;
    return this.items[r.item].rt!.light(r.group);
  }

  legLight(it: SignalItem, leg: number): Light | null {
    const g = it.legGroup[leg];
    if (!it.rt || g < 0) return null;
    return it.rt.light(g);
  }

  /** Начальное состояние всех светофоров (время 0) с сохранением режимов и включённости — для «Сброса» с тем же seed. */
  reset() {
    this.t = 0;
    for (const it of this.items) {
      if (!it.rt) continue;
      const { mode, status } = it.rt;
      it.rt = new SignalRuntime(it.groups, it.timing, 0);
      it.rt.mode = mode;
      it.rt.status = status;
    }
  }

  setModeAll(mode: ControlMode) {
    for (const it of this.items) it.rt?.setMode(mode);
  }

  counts() {
    const c = { working: 0, inactive: 0, no_data: 0, fixed: 0, adaptive: 0, manual: 0 };
    for (const it of this.items) {
      c[this.status(it)]++;
      if (it.rt) c[it.rt.mode]++;
    }
    return c;
  }
}
