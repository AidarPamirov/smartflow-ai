import { chromium } from 'playwright';
const OUT = process.argv[2];
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const log = (...a) => console.log(...a);
const errsOf = (p) => { const e = []; p.on('console', (m) => { if (m.type() === 'error') e.push(m.text().slice(0, 300)); }); p.on('pageerror', (x) => e.push('PAGEERROR ' + x)); return e; };
const stats = (p) => p.evaluate(() => ({ clock: document.querySelector('.traffic-clock')?.textContent ?? null, stats: document.querySelector('.traffic-stats')?.textContent ?? null, msg: document.querySelector('.traffic-msg')?.textContent ?? null, mapErr: document.querySelector('.map-error')?.textContent ?? null }));
const fps = (p, ms = 4000) => p.evaluate((ms) => new Promise((res) => { let f = 0; const t0 = performance.now(); const loop = () => { f++; if (performance.now() - t0 < ms) requestAnimationFrame(loop); else res(+(f / (ms / 1000)).toFixed(1)); }; requestAnimationFrame(loop); }), ms);
const toSec = (c) => { const p = c.split(':').map(Number); return p.reduce((a, x) => a * 60 + x, 0); };

// 1. Компьютер: карта + трафик
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = errsOf(p);
await p.goto('http://localhost:4173/');
await p.waitForSelector('.map-overlay', { state: 'detached', timeout: 60000 });
const fpsNoTraffic = await fps(p, 3000);
await p.waitForSelector('.traffic-play', { timeout: 60000 });
await p.waitForTimeout(5000);
log('ready', JSON.stringify(await stats(p)));
await p.screenshot({ path: `${OUT}/01-center-3d.png` });
const fps250 = await fps(p);

// пауза
await p.click('.traffic-play'); await p.waitForTimeout(400);
const c1 = (await stats(p)).clock; await p.waitForTimeout(2500); const c2 = (await stats(p)).clock;
log('pause clock', c1, c2, c1 === c2 ? 'OK' : 'FAIL');
await p.click('.traffic-play');
// скорость 10×
await p.click('.traffic-seg >> text=10×'); await p.waitForTimeout(3000);
const c3 = (await stats(p)).clock; log('10x clock after 3 s', c3, 'delta', toSec(c3) - toSec(c2));
await p.click('.traffic-seg >> text=1×');
// сброс
await p.click('text=↺ Сброс'); await p.waitForTimeout(400); log('after reset', (await stats(p)).clock);
// 1000 машин
await p.selectOption('#traffic-count', '1000'); await p.waitForTimeout(3000);
log('1000', JSON.stringify(await stats(p)));
const fps1000 = await fps(p);
await p.screenshot({ path: `${OUT}/02-1000-cars.png` });

// крупно: силуэты машин
for (let i = 0; i < 2; i++) { await p.click('[aria-label="Приблизить"]'); await p.waitForTimeout(700); }
await p.waitForTimeout(5000);
await p.screenshot({ path: `${OUT}/03-close-17.png` });
log('close', JSON.stringify(await stats(p)));
// дорожный граф поверх, план
await p.click('text=План'); await p.waitForTimeout(1500);
await p.check('.traffic-check input'); await p.waitForTimeout(3000);
await p.screenshot({ path: `${OUT}/04-close-plan-graph.png` });
await p.click('[aria-label="Вернуться к центру Бишкека"]'); await p.waitForTimeout(4000);
await p.screenshot({ path: `${OUT}/05-plan-graph-center.png` });
// мелкий масштаб: трафик скрыт
for (let i = 0; i < 4; i++) { await p.click('[aria-label="Отдалить"]'); await p.waitForTimeout(500); }
await p.waitForTimeout(2500);
log('zoomed out', JSON.stringify(await stats(p)));
await p.screenshot({ path: `${OUT}/06-zoomed-out.png` });
log('fps (swiftshader, только для сравнения): без трафика', fpsNoTraffic, '| 250 машин', fps250, '| 1000 машин', fps1000);
log('desktop errors', JSON.stringify(errs));

// 2. Ошибка загрузки сети: карта работает, панель показывает причину, «Повторить» помогает
const q = await b.newPage({ viewport: { width: 1280, height: 800 } });
const qerr = errsOf(q);
let fail = true;
await q.route('**/data/bishkek-roads.json', (r) => (fail ? r.fulfill({ status: 404, body: 'nope' }) : r.continue()));
await q.goto('http://localhost:4173/');
await q.waitForSelector('.traffic-err', { timeout: 60000 });
log('error state', JSON.stringify(await stats(q)), 'map canvas', await q.isVisible('.maplibregl-canvas'));
await q.screenshot({ path: `${OUT}/07-network-error.png` });
fail = false;
await q.click('.traffic-err button');
await q.waitForSelector('.traffic-play', { timeout: 60000 });
log('after retry', JSON.stringify(await stats(q)));
// повреждённый файл
const r2 = await b.newPage();
await r2.route('**/data/bishkek-roads.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"format":"smartflow-road-network/1"}' }));
await r2.goto('http://localhost:4173/');
await r2.waitForSelector('.traffic-err', { timeout: 60000 });
log('corrupt file', JSON.stringify(await stats(r2)));
log('error page errors', JSON.stringify(qerr));

// 3. Телефон
const m = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const merr = errsOf(m);
await m.goto('http://localhost:4173/');
await m.waitForSelector('.traffic-play', { timeout: 60000 });
await m.waitForTimeout(5000);
log('phone hscroll', await m.evaluate(() => document.documentElement.scrollWidth > innerWidth), JSON.stringify(await stats(m)));
await m.screenshot({ path: `${OUT}/08-phone.png` });
log('phone errors', JSON.stringify(merr));
await b.close();
