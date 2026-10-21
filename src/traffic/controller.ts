/**
 * Связывает части демо-трафика: загрузка сети → генерация маршрутов → движение → отрисовка.
 * Интерфейс (TrafficPanel) только читает состояние и вызывает команды.
 */
import type { Map as MlMap } from 'maplibre-gl';
import { Fleet, type FleetStats, type VehiclePose } from './fleet';
import { NetworkError, loadNetwork, type Network, type NetworkMeta } from './network';
import { RouteGenerator, type Route } from './routing';
import { TrafficLayer, MIN_ZOOM } from './trafficLayer';

export type TrafficPhase = 'waiting' | 'loading' | 'routing' | 'ready' | 'error';

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
  meta: NetworkMeta | null;
}

export const SPEEDS = [1, 2, 5, 10] as const;
export const COUNTS = [100, 250, 500, 1000] as const;
export const SEED = 2026;
const POOL_SIZE = 240;
const RENDER_EVERY_MS = 33;
const STATE_EVERY_MS = 250;
const MAX_FRAME_DT = 0.1;

export class TrafficController {
  private state: TrafficState = {
    phase: 'waiting', error: null, progress: 0, poolSize: POOL_SIZE, running: false, speed: 1, count: 250,
    stats: { vehicles: 0, trips: 0, meanSpeed: 0, simTime: 0 }, rendered: 0, inView: 0, zoomTooLow: false, networkVisible: false, meta: null,
  };
  private net: Network | null = null;
  private pool: Route[] = [];
  private fleet: Fleet | null = null;
  private layer: TrafficLayer | null = null;
  private cont: RouteGenerator | null = null;
  private raf = 0;
  private last = 0;
  private lastRender = 0;
  private lastState = 0;
  private dirty = true;
  private cancel = { cancelled: false };
  private abort = new AbortController();
  private onMove = () => { this.dirty = true; };

  constructor(private map: MlMap, private url: string, private onState: (s: TrafficState) => void) {}

  private emit(patch: Partial<TrafficState> = {}) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  /** Загрузка сети и подготовка маршрутов. Повторный вызов после ошибки — «Повторить». */
  async init() {
    this.cancel = { cancelled: false };
    this.abort = new AbortController();
    this.emit({ phase: 'loading', error: null, progress: 0 });
    try {
      this.net = await loadNetwork(this.url, this.abort.signal);
      this.emit({ phase: 'routing', meta: this.net.meta });
      const gen = new RouteGenerator(this.net, SEED);
      this.pool = await gen.pool(POOL_SIZE, (done) => this.emit({ progress: done }), this.cancel);
      if (this.cancel.cancelled) return;
      this.layer = new TrafficLayer(this.map, this.net);
      this.layer.attach();
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
      this.emit({ phase: 'error', error: msg, running: false });
    }
  }

  private makeFleet() {
    const net = this.net!;
    // отдельный генератор для продолжения поездок: сброс воспроизводит ту же картину
    this.cont = new RouteGenerator(net, SEED + 1);
    const cont = this.cont;
    this.fleet = new Fleet(this.pool, SEED, this.state.count, (r, a) => !net.edges[r.arcs[a].edge].oneway, (node) => cont.from(node));
  }

  private *poses(): Generator<VehiclePose> {
    const f = this.fleet;
    if (!f) return;
    for (const v of f.vehicles) yield f.pose(v);
  }

  private tick = (now: number) => {
    const dtReal = Math.min(MAX_FRAME_DT, (now - this.last) / 1000);
    this.last = now;
    if (this.fleet && this.state.running) {
      this.fleet.step(dtReal * this.state.speed);
      this.dirty = true;
    }
    if (this.dirty && now - this.lastRender >= RENDER_EVERY_MS && this.layer) {
      const r = this.layer.update(this.poses());
      this.state.rendered = r.rendered;
      this.state.inView = r.inView;
      this.lastRender = now;
      this.dirty = false;
    }
    if (now - this.lastState >= STATE_EVERY_MS && this.fleet) {
      this.lastState = now;
      this.emit({ stats: this.fleet.stats(), zoomTooLow: this.map.getZoom() < MIN_ZOOM });
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  toggle() { if (this.state.phase === 'ready') this.emit({ running: !this.state.running }); }
  setSpeed(speed: number) { this.emit({ speed }); }
  setCount(count: number) {
    this.fleet?.setCount(count);
    this.dirty = true;
    this.emit({ count, stats: this.fleet?.stats() ?? this.state.stats });
  }
  reset() {
    if (!this.fleet || !this.net) return;
    this.makeFleet();
    this.dirty = true;
    this.emit({ stats: this.fleet.stats() });
  }
  setNetworkVisible(v: boolean) {
    this.layer?.setNetworkVisible(v);
    this.emit({ networkVisible: v });
  }

  destroy() {
    this.cancel.cancelled = true;
    this.abort.abort();
    cancelAnimationFrame(this.raf);
    this.map.off('move', this.onMove);
    this.layer?.detach();
    this.layer = null;
    this.fleet = null;
  }
}
