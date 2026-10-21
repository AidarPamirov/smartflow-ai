/**
 * Связывает части городской модели: загрузка сети → маршруты → движение → светофоры → отрисовка.
 * Интерфейс (TrafficPanel, SignalPanel, LayersPanel) только читает состояние и вызывает команды.
 *
 * Светофоры подключаются, если загрузился файл фактов OSM о светофорах; без него демо-трафик работает как раньше
 * (без регулирования), а интерфейс сообщает, что светофоры недоступны.
 */
import type { Map as MlMap } from 'maplibre-gl';
import { ALL_CAMERAS, CameraLayer, type CameraFilter } from '../cameras/cameraLayer';
import { CameraSystem, type CameraMetrics } from '../cameras/system';
import type { Camera, CameraEvent, CameraSettings, ConnStatus } from '../cameras/types';
import { CongestionMeter } from './congestion';
import { CongestionLayer } from './congestionLayer';
import { cityObserve, legObs } from '../signals/observe';
import { SignalDataError, parseOsmSignals, type Inventory, type RawOsmSignals } from '../signals/inventory';
import { fromWhere } from '../signals/plan';
import type { ControlMode, Decision, Light } from '../signals/runtime';
import { ALL_SIGNALS, SignalLayer, type SignalFilter } from '../signals/signalLayer';
import { SignalSystem, type ItemStatus } from '../signals/system';
import { Fleet, type ApproachObs, type FleetStats, type SignalHook, type VehiclePose } from './fleet';
import { NetworkError, loadNetwork, type Network, type NetworkMeta, type RoadClass } from './network';
import { RouteGenerator, type Route } from './routing';
import { TrafficLayer, MIN_ZOOM } from './trafficLayer';

export type TrafficPhase = 'waiting' | 'loading' | 'routing' | 'ready' | 'error';

export interface SelectedSignal {
  index: number;
  id: string;
  lon: number;
  lat: number;
  status: ItemStatus;
  mode: ControlMode | null;
  zone: { title: string; href: string } | null;
  osmSignals: number[];
  crossings: { total: number; signalized: number };
  note: string | null;
  stage: 'green' | 'yellow' | 'allred' | null;
  phase: number;
  next: number;
  timeToSwitch: number | null;
  minGreenLeft: number;
  cycle: number;
  phases: { label: string; light: Light; green: number; pedestrian: boolean }[];
  legs: { name: string; from: string; cls: RoadClass; lanesIn: number; lanesOut: number; light: Light | null; phase: number; obs: ApproachObs }[];
  log: Decision[];
}

export interface SignalsState {
  phase: 'off' | 'loading' | 'ready' | 'error';
  error: string | null;
  visible: boolean;
  filter: SignalFilter;
  counts: ReturnType<SignalSystem['counts']> | null;
  stats: Inventory['stats'] | null;
  osmBase: string | null;
  heads: number;
  selected: SelectedSignal | null;
}

export interface SelectedCamera {
  index: number;
  camera: Camera;
  status: ConnStatus;
  metrics: CameraMetrics;
  events: CameraEvent[];
  totalEvents: number;
  signalId: string | null;
}

export interface CamerasState {
  phase: 'off' | 'ready' | 'error';
  error: string | null;
  visible: boolean;
  filter: CameraFilter;
  counts: Record<Camera['type'], number> | null;
  selected: SelectedCamera | null;
}

export interface TrafficState {
  phase: TrafficPhase;
  error: string | null;
  progress: number;
  poolSize: number;
  running: boolean;
  speed: number;
  count: number;
  stats: FleetStats;
  rendered: number;
  inView: number;
  zoomTooLow: boolean;
  networkVisible: boolean;
  trafficVisible: boolean;
  meta: NetworkMeta | null;
  signals: SignalsState;
  cameras: CamerasState;
  congestion: { visible: boolean; histogram: number[] | null };
}

export const SPEEDS = [1, 2, 5, 10] as const;
export const COUNTS = [100, 250, 500, 1000] as const;
export const SEED = 2026;
const POOL_SIZE = 240;
/** Интервал обновления слоя: 33 мс (≈30 Гц), на медленных устройствах реже — см. tick. */
const RENDER_EVERY_MS = 33;
const STATE_EVERY_MS = 250;
const HEADS_EVERY_MS = 250;
/** Предел шага за кадр, с: после сворачивания вкладки машины не «прыгают». */
const MAX_FRAME_DT = 0.25;
const LOG_SHOWN = 8;
const CONGESTION_EVERY_MS = 2000;

export class TrafficController {
  private state: TrafficState = {
    phase: 'waiting', error: null, progress: 0, poolSize: POOL_SIZE, running: false, speed: 1, count: 250,
    stats: { vehicles: 0, trips: 0, meanSpeed: 0, simTime: 0 }, rendered: 0, inView: 0, zoomTooLow: false, networkVisible: false,
    trafficVisible: true, meta: null,
    signals: { phase: 'off', error: null, visible: true, filter: ALL_SIGNALS, counts: null, stats: null, osmBase: null, heads: 0, selected: null },
    cameras: { phase: 'off', error: null, visible: true, filter: ALL_CAMERAS, counts: null, selected: null },
    congestion: { visible: false, histogram: null },
  };
  private net: Network | null = null;
  private pool: Route[] = [];
  private fleet: Fleet | null = null;
  private layer: TrafficLayer | null = null;
  private cont: RouteGenerator | null = null;
  private signals: SignalSystem | null = null;
  private signalLayer: SignalLayer | null = null;
  private hook: SignalHook | undefined;
  private obs = new Map<number, ApproachObs>();
  private selected: number | null = null;
  private cameras: CameraSystem | null = null;
  private cameraLayer: CameraLayer | null = null;
  private selectedCam: number | null = null;
  private congestion: CongestionMeter | null = null;
  private congestionLayer: CongestionLayer | null = null;
  private lastCongestion = 0;
  private raf = 0;
  private last = 0;
  private lastRender = 0;
  private lastState = 0;
  private lastHeads = 0;
  private dirty = true;
  private sitesDirty = false;
  /** Скользящее среднее длительности кадра, мс: если устройство не успевает, слой обновляется реже. */
  private frameMs = 16;
  private cancel = { cancelled: false };
  private abort = new AbortController();
  private onMove = () => { this.dirty = true; this.lastHeads = 0; };

  constructor(private map: MlMap, private url: string, private onState: (s: TrafficState) => void, private signalsUrl?: string) {}

  private emit(patch: Partial<TrafficState> = {}) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  private emitSignals(patch: Partial<SignalsState> = {}) {
    this.emit({ signals: { ...this.state.signals, ...patch, selected: this.selectedState() } });
  }

  private emitCameras(patch: Partial<CamerasState> = {}) {
    this.emit({ cameras: { ...this.state.cameras, ...patch, selected: this.selectedCamState() } });
  }

  /** Загрузка сети и подготовка маршрутов. Повторный вызов после ошибки — «Повторить». */
  async init() {
    this.cancel = { cancelled: false };
    this.abort = new AbortController();
    this.emit({ phase: 'loading', error: null, progress: 0 });
    try {
      this.net = await loadNetwork(this.url, this.abort.signal);
      this.emit({ phase: 'routing', meta: this.net.meta });
      const signalsP = this.loadSignals();
      const gen = new RouteGenerator(this.net, SEED);
      this.pool = await gen.pool(POOL_SIZE, (done) => this.emit({ progress: done }), this.cancel);
      if (this.cancel.cancelled) return;
      await signalsP;
      if (this.cancel.cancelled) return;
      this.layer = new TrafficLayer(this.map, this.net);
      this.layer.attach();
      this.congestion = new CongestionMeter(this.net);
      this.congestionLayer = new CongestionLayer(this.map, this.congestion);
      this.congestionLayer.attach();
      this.signalLayer?.attach();
      this.cameraLayer?.attach();
      this.makeFleet();
      this.map.on('move', this.onMove);
      this.emit({ phase: 'ready', running: true });
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || this.cancel.cancelled) return;
      const msg = e instanceof NetworkError ? e.message : `не удалось подготовить трафик: ${(e as Error).message}`;
      this.layer?.detach();
      this.layer = null;
      this.signalLayer?.detach();
      this.signalLayer = null;
      this.cameraLayer?.detach();
      this.cameraLayer = null;
      this.congestionLayer?.detach();
      this.congestionLayer = null;
      this.emit({ phase: 'error', error: msg, running: false });
    }
  }

  /** Факты OSM о светофорах → городская сеть светофоров. Ошибка не мешает трафику. */
  private async loadSignals() {
    if (!this.signalsUrl || !this.net) return;
    this.emitSignals({ phase: 'loading', error: null });
    try {
      let res: Response;
      try { res = await fetch(this.signalsUrl, { signal: this.abort.signal }); } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        throw new SignalDataError('нет связи с сервером');
      }
      if (!res.ok) throw new SignalDataError(`файл светофоров не найден (HTTP ${res.status})`);
      let raw: unknown;
      try { raw = await res.json(); } catch { throw new SignalDataError('файл светофоров повреждён (не JSON)'); }
      const osm: RawOsmSignals = parseOsmSignals(raw);
      const sys = new SignalSystem(this.net, osm);
      this.signals = sys;
      this.hook = { controlled: (k) => sys.byArc.has(k), light: (k) => sys.lightForArc(k) };
      this.signalLayer = new SignalLayer(this.map, sys, osm, (i) => this.selectSignal(i));
      this.emitSignals({ phase: 'ready', counts: sys.counts(), stats: sys.inv.stats, osmBase: osm.meta.osm_base });
      // камеры расставляются по светофорам и магистралям графа
      const cams = new CameraSystem(this.net, undefined, sys);
      this.cameras = cams;
      this.cameraLayer = new CameraLayer(this.map, cams, (i) => this.selectCamera(i));
      const counts = { flow: 0, speed: 0, line: 0, seatbelt: 0 };
      for (const c of cams.cameras) counts[c.type]++;
      this.emitCameras({ phase: 'ready', counts });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      this.signals = null;
      this.hook = undefined;
      this.emitSignals({ phase: 'error', error: e instanceof SignalDataError ? e.message : (e as Error).message });
      this.emitCameras({ phase: 'error', error: 'камеры расставляются по светофорам OSM, а они не загрузились' });
    }
  }

  private makeFleet() {
    const net = this.net!;
    // отдельный генератор для продолжения поездок: сброс воспроизводит ту же картину
    this.cont = new RouteGenerator(net, SEED + 1);
    const cont = this.cont;
    this.fleet = new Fleet(this.pool, SEED, this.state.count, (r, a) => !net.edges[r.arcs[a].edge].oneway, (node) => cont.from(node), this.hook);
  }

  private *poses(): Generator<VehiclePose> {
    const f = this.fleet;
    if (!f) return;
    for (const v of f.vehicles) yield f.pose(v);
  }

  private tick = (now: number) => {
    const dtReal = Math.min(MAX_FRAME_DT, (now - this.last) / 1000);
    this.frameMs = this.frameMs * 0.9 + Math.min(500, now - this.last) * 0.1;
    this.last = now;
    const renderEvery = this.frameMs > 45 ? 100 : this.frameMs > 25 ? 50 : RENDER_EVERY_MS;
    if (this.fleet && this.state.running) {
      const dt = dtReal * this.state.speed;
      this.fleet.step(dt);
      if (this.signals) {
        this.obs = this.fleet.approachObs();
        const obs = this.obs, sys = this.signals;
        sys.step(dt, (it) => cityObserve(it, obs, sys.t));
      }
      const fleet = this.fleet;
      this.cameras?.process(fleet.vehicles, (v) => fleet.pose(v), dt, this.obs);
      this.congestion?.update(fleet.vehicles, dt);
      this.dirty = true;
    }
    if (this.congestionLayer?.isVisible && now - this.lastCongestion >= CONGESTION_EVERY_MS) {
      this.lastCongestion = now;
      this.congestionLayer.update();
    }
    if (this.dirty && now - this.lastRender >= renderEvery && this.layer) {
      const r = this.layer.update(this.poses());
      this.state.rendered = r.rendered;
      this.state.inView = r.inView;
      this.lastRender = now;
      this.dirty = false;
    }
    if (this.signalLayer && now - this.lastHeads >= HEADS_EVERY_MS) {
      this.lastHeads = now;
      if (this.sitesDirty) { this.signalLayer.refreshSites(); this.sitesDirty = false; }
      this.state.signals.heads = this.signalLayer.updateHeads();
    }
    if (now - this.lastState >= STATE_EVERY_MS && this.fleet) {
      this.lastState = now;
      this.state = {
        ...this.state,
        signals: { ...this.state.signals, counts: this.signals?.counts() ?? null, selected: this.selectedState() },
        cameras: { ...this.state.cameras, selected: this.selectedCamState() },
        congestion: { ...this.state.congestion, histogram: this.state.congestion.visible ? this.congestion?.histogram() ?? null : null },
      };
      this.emit({ stats: this.fleet.stats(), zoomTooLow: this.map.getZoom() < MIN_ZOOM });
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private selectedState(): SelectedSignal | null {
    const sys = this.signals;
    if (!sys || this.selected === null) return null;
    const it = sys.items[this.selected];
    if (!it) return null;
    const rt = it.rt;
    return {
      index: it.index,
      id: it.site.id,
      lon: it.site.lon,
      lat: it.site.lat,
      status: sys.status(it),
      mode: rt?.mode ?? null,
      zone: it.zone ? { title: it.zone.title, href: it.zone.href } : null,
      osmSignals: it.site.osmSignals,
      crossings: it.site.crossings,
      note: it.site.note,
      stage: rt ? rt.state.stage : null,
      phase: rt ? rt.state.phase : 0,
      next: rt ? rt.state.next : 0,
      timeToSwitch: rt ? rt.timeToSwitch() : null,
      minGreenLeft: rt ? rt.minGreenLeft() : 0,
      cycle: it.timing.cycle,
      phases: it.groups.map((g, k) => ({ label: g.label, light: rt ? rt.light(k) : 'off', green: it.timing.greens[k], pedestrian: !!g.pedestrian })),
      legs: it.site.legs.map((l, li) => ({
        name: l.name, from: fromWhere(l.bearing), cls: l.cls, lanesIn: l.lanesIn, lanesOut: l.lanesOut,
        light: sys.legLight(it, li), phase: it.legGroup[li], obs: legObs(it, li, this.obs),
      })),
      log: rt ? rt.log.slice(-LOG_SHOWN).reverse() : [],
    };
  }

  private selectedCamState(): SelectedCamera | null {
    const sys = this.cameras;
    if (!sys || this.selectedCam === null) return null;
    const c = sys.cameras[this.selectedCam];
    if (!c) return null;
    return {
      index: this.selectedCam,
      camera: { ...c, settings: { ...c.settings } },
      status: sys.status(this.selectedCam),
      metrics: sys.metrics(this.selectedCam, this.obs),
      events: sys.events(this.selectedCam).slice(0, 10),
      totalEvents: sys.totalEvents(this.selectedCam),
      signalId: c.signal >= 0 ? this.signals?.items[c.signal]?.site.id ?? null : null,
    };
  }

  // ───────── команды интерфейса: трафик ─────────

  toggle() { if (this.state.phase === 'ready') this.emit({ running: !this.state.running }); }
  setSpeed(speed: number) { this.emit({ speed }); }
  setCount(count: number) {
    this.fleet?.setCount(count);
    this.dirty = true;
    this.emit({ count, stats: this.fleet?.stats() ?? this.state.stats });
  }
  reset() {
    if (!this.fleet || !this.net) return;
    this.signals?.reset();
    this.cameras?.reset();
    this.congestion?.reset();
    this.makeFleet();
    this.obs = new Map();
    this.dirty = true;
    this.emit({ stats: this.fleet.stats() });
  }
  setNetworkVisible(v: boolean) {
    this.layer?.setNetworkVisible(v);
    this.emit({ networkVisible: v });
  }
  setTrafficVisible(v: boolean) {
    this.layer?.setVisible(v);
    this.emit({ trafficVisible: v });
  }

  // ───────── команды интерфейса: светофоры ─────────

  selectSignal(i: number | null) {
    this.selected = i;
    this.signalLayer?.setSelected(i);
    if (i !== null && this.selectedCam !== null) { this.selectedCam = null; this.cameraLayer?.setSelected(null); this.emitCameras(); }
    this.emitSignals();
  }

  // ───────── команды интерфейса: камеры и загруженность ─────────

  selectCamera(i: number | null) {
    this.selectedCam = i;
    this.cameraLayer?.setSelected(i);
    if (i !== null && this.selected !== null) { this.selected = null; this.signalLayer?.setSelected(null); this.emitSignals(); }
    this.emitCameras();
  }
  setCameraSettings(i: number, patch: Partial<CameraSettings>) {
    this.cameras?.setSettings(i, patch);
    if (patch.enabled !== undefined) this.cameraLayer?.refresh();
    this.emitCameras();
  }
  setCameraFilter(f: CameraFilter) { this.cameraLayer?.setFilter(f); this.emitCameras({ filter: f }); }
  setCamerasVisible(v: boolean) { this.cameraLayer?.setVisible(v); this.emitCameras({ visible: v }); }
  setCongestionVisible(v: boolean) {
    this.congestionLayer?.setVisible(v);
    this.emit({ congestion: { visible: v, histogram: v ? this.congestion?.histogram() ?? null : null } });
  }
  selectCameraById(id: string): boolean {
    const i = this.cameras?.cameras.findIndex((c) => c.id === id) ?? -1;
    if (i < 0) return false;
    this.selectCamera(i);
    this.flyToCamera(i);
    return true;
  }
  flyToCamera(i: number) {
    const c = this.cameras?.cameras[i];
    if (c) this.map.flyTo({ center: [c.lon, c.lat], zoom: Math.max(this.map.getZoom(), 17), duration: 900 });
  }
  private changed() { this.sitesDirty = true; this.lastHeads = 0; this.emitSignals({ counts: this.signals?.counts() ?? null }); }
  setSignalMode(i: number, mode: ControlMode) { this.signals?.items[i]?.rt?.setMode(mode); this.changed(); }
  setAllSignalModes(mode: ControlMode) { this.signals?.setModeAll(mode); this.changed(); }
  requestPhase(i: number, k: number) { const rt = this.signals?.items[i]?.rt; if (rt && rt.mode === 'manual') rt.requestPhase(k); this.emitSignals(); }
  setSignalActive(i: number, on: boolean) { this.signals?.items[i]?.rt?.setStatus(on ? 'working' : 'inactive'); this.changed(); }
  setSignalFilter(f: SignalFilter) { this.signalLayer?.setFilter(f); this.lastHeads = 0; this.emitSignals({ filter: f }); }
  setSignalsVisible(v: boolean) {
    this.signalLayer?.setVisible(v);
    // выключенный слой — только отображение: светофоры продолжают работать и регулировать движение
    this.emitSignals({ visible: v });
  }
  /** Выбрать светофор по ID (ссылка вида #signal=tls-…). false — такого нет или светофоры не загружены. */
  selectSignalById(id: string): boolean {
    const it = this.signals?.items.find((x) => x.site.id === id);
    if (!it) return false;
    this.selectSignal(it.index);
    this.flyToSignal(it.index);
    return true;
  }

  /** Перелёт к светофору (из панели). */
  flyToSignal(i: number) {
    const it = this.signals?.items[i];
    if (it) this.map.flyTo({ center: [it.site.lon, it.site.lat], zoom: Math.max(this.map.getZoom(), 16.5), duration: 900 });
  }

  destroy() {
    this.cancel.cancelled = true;
    this.abort.abort();
    cancelAnimationFrame(this.raf);
    this.map.off('move', this.onMove);
    this.layer?.detach();
    this.layer = null;
    this.signalLayer?.detach();
    this.signalLayer = null;
    this.cameraLayer?.detach();
    this.cameraLayer = null;
    this.congestionLayer?.detach();
    this.congestionLayer = null;
    this.fleet = null;
    this.signals = null;
    this.cameras = null;
  }
}
