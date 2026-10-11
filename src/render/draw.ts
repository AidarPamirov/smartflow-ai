import { VEH_W } from '../sim/conflicts';
import {
  APPROACH, CURB_R, DIRS, ENTRY, HALF, LANE_W, LANES_PER_APPROACH, STOP_S, VIEW, heading, rightOf, type Dir, type Maneuver,
} from '../sim/geometry';
import { PATHS, poseAt, type Path } from '../sim/routes';
import type { MoveLight, Simulation } from '../sim/simulation';
import { STOP_SPEED } from '../sim/vehicle';

export interface Theme {
  ground: string; road: string; mark: string; center: string; text: string;
  man: Record<Maneuver, string>; brake: string; zone: string; zoneOther: string;
  sigGreen: string; sigYellow: string; sigRed: string; signalOff: string;
}

export function readTheme(el: HTMLElement): Theme {
  const cs = getComputedStyle(el);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    ground: v('--canvas-ground'), road: v('--canvas-road'), mark: v('--canvas-mark'), center: v('--canvas-center'),
    text: v('--text-primary'),
    man: { T: v('--man-T'), L: v('--man-L'), R: v('--man-R'), U: v('--man-U') },
    brake: v('--brake'), zone: v('--zone'), zoneOther: v('--zone-other'),
    sigGreen: v('--sig-green'), sigYellow: v('--sig-yellow'), sigRed: v('--sig-red'), signalOff: v('--sig-off'),
  };
}

/** Точка подхода dir: смещение off вправо от осевой, расстояние dist от центра (против хода). */
function pt(dir: Dir, off: number, dist: number) {
  const h = heading(dir), r = rightOf(h);
  return { x: -h.x * dist + r.x * off, y: -h.y * dist + r.y * off };
}

function line(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }) {
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
}

function strokePath(ctx: CanvasRenderingContext2D, p: Path, s0: number, s1: number) {
  ctx.beginPath();
  for (let s = s0, first = true; s <= s1 + 1e-6; s += 0.5, first = false) {
    const q = poseAt(p, s);
    if (first) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
}

export interface DrawOptions { debug: boolean; /** Половина видимой области, м. */ view?: number }

export function drawScene(ctx: CanvasRenderingContext2D, sim: Simulation, w: number, h: number, th: Theme, opt: DrawOptions): void {
  const V = opt.view ?? VIEW;
  const scale = Math.min(w, h) / (2 * V);
  ctx.save();
  ctx.fillStyle = th.ground;
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.scale(scale, scale);

  // Дорожное полотно, зона перекрёстка со скруглёнными углами (радиус бордюра)
  ctx.fillStyle = th.road;
  ctx.fillRect(-HALF, -VIEW, 2 * HALF, 2 * VIEW);
  ctx.fillRect(-VIEW, -HALF, 2 * VIEW, 2 * HALF);
  ctx.fillRect(-ENTRY, -ENTRY, 2 * ENTRY, 2 * ENTRY);
  ctx.fillStyle = th.ground;
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    ctx.beginPath();
    ctx.arc(sx * ENTRY, sy * ENTRY, CURB_R, 0, Math.PI * 2);
    ctx.fill();
  }

  // Разметка вне зоны перекрёстка
  ctx.lineWidth = 0.15;
  for (const dir of DIRS) {
    ctx.strokeStyle = th.center;
    ctx.setLineDash([]);
    for (const o of [-0.15, 0.15]) line(ctx, pt(dir, o, VIEW), pt(dir, o, ENTRY));
    ctx.strokeStyle = th.mark;
    for (let l = 1; l < LANES_PER_APPROACH; l++) {
      ctx.setLineDash([]);
      line(ctx, pt(dir, l * LANE_W, ENTRY + 14), pt(dir, l * LANE_W, ENTRY)); // сплошная перед стоп-линией
      ctx.setLineDash([3, 4]);
      line(ctx, pt(dir, l * LANE_W, VIEW), pt(dir, l * LANE_W, ENTRY + 14));
      line(ctx, pt(dir, -l * LANE_W, VIEW), pt(dir, -l * LANE_W, ENTRY));
    }
    ctx.setLineDash([]);
    ctx.lineWidth = 0.5;
    const stopDist = ENTRY + (APPROACH - STOP_S);
    line(ctx, pt(dir, 0.3, stopDist), pt(dir, HALF, stopDist));
    ctx.lineWidth = 0.15;
  }

  // Отладка: траектории всех манёвров плана и удерживаемые конфликтные зоны
  if (opt.debug) {
    const inPlan = new Set(sim.phases.flatMap((p) => [...p.status.keys()]));
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 0.25;
    for (const p of PATHS.values()) {
      if (!inPlan.has(p.id)) continue;
      ctx.strokeStyle = th.man[p.man];
      ctx.setLineDash(sim.lightOf(p.id) === 'R' ? [0.8, 0.8] : []);
      strokePath(ctx, p, p.connStart - 8, p.connEnd + 8);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = VEH_W + 0.6;
    ctx.lineCap = 'round';
    for (const { path, c } of sim.heldZones()) {
      const other = PATHS.get(c.other)!;
      ctx.strokeStyle = th.zoneOther; // зона, закрытая для конфликтующего маршрута
      strokePath(ctx, other, c.oa - 4.5, c.ob);
      ctx.strokeStyle = th.zone; // та же зона на пути машины, которая её держит
      strokePath(ctx, path, c.a - 4.5, c.b);
    }
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;
  }

  // Светофоры: над каждой полосой у стоп-линии. Полоса 0 — сигнал левого, полоса 1 — прямого.
  for (const dir of DIRS) {
    for (let lane = 0; lane < LANES_PER_APPROACH; lane++) {
      const id = lane === 0 ? `${dir}0L` : `${dir}1T`;
      const light: MoveLight = sim.lightOf(id);
      const c = pt(dir, lane * LANE_W + LANE_W / 2, ENTRY - 1.4);
      ctx.fillStyle = th.signalOff;
      ctx.beginPath(); ctx.arc(c.x, c.y, 1.0, 0, Math.PI * 2); ctx.fill();
      const col = light === 'R' ? th.sigRed : light === 'Y' ? th.sigYellow : th.sigGreen;
      if (light === 'g') {
        // зелёный с уступкой — кольцо
        ctx.strokeStyle = col; ctx.lineWidth = 0.35;
        ctx.beginPath(); ctx.arc(c.x, c.y, 0.55, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(c.x, c.y, 0.72, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // Автомобили: кузов по касательной к пути
  for (const v of sim.allVehicles()) {
    const c = poseAt(v.path, v.s - v.len / 2);
    if (Math.abs(c.x) > V + 5 || Math.abs(c.y) > V + 5) continue;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.h);
    ctx.fillStyle = th.man[v.man];
    roundRect(ctx, -v.len / 2, -0.9, v.len, 1.8, 0.45);
    ctx.fill();
    if (opt.debug && v.committed && !v.crossed) {
      ctx.strokeStyle = th.text; ctx.lineWidth = 0.3; ctx.stroke();
    }
    if (v.a < -0.8 || v.v < STOP_SPEED) {
      ctx.fillStyle = th.brake;
      ctx.fillRect(-v.len / 2, -0.85, 0.35, 0.5);
      ctx.fillRect(-v.len / 2, 0.35, 0.35, 0.5);
    }
    ctx.restore();
  }

  ctx.restore();

  // Подписи в экранных координатах
  ctx.save();
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'middle';
  for (const dir of DIRS) {
    const n = V < VIEW ? sim.queueOf(dir) : sim.backlogCount(dir);
    if (n === 0) continue;
    const p = pt(dir, HALF / 2, V - 4);
    const sx = w / 2 + p.x * scale, sy = h / 2 + p.y * scale;
    const label = V < VIEW ? `очередь ${sim.queueOf(dir)}` : `+${n} ждут въезда`;
    const tw = ctx.measureText(label).width;
    const bx = Math.min(Math.max(sx - tw / 2 - 6, 4), w - tw - 16);
    const by = Math.min(Math.max(sy - 10, 4), h - 24);
    ctx.fillStyle = th.ground;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(bx, by, tw + 12, 20);
    ctx.globalAlpha = 1;
    ctx.fillStyle = th.text;
    ctx.fillText(label, bx + 6, by + 10);
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

