import { chromium } from 'playwright';
const OUT = process.argv[2];
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const log = (...a) => console.log(...a);

async function open(vp, url) {
  const p = await b.newPage({ viewport: vp });
  const errs = []; const tiles = { ok: 0, fail: 0, kb: 0 };
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text().slice(0, 300)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e));
  p.on('response', async (r) => {
    if (!r.url().includes('openfreemap')) return;
    if (r.ok()) { tiles.ok++; try { tiles.kb += (await r.body()).length / 1024; } catch {} } else tiles.fail++;
  });
  p.on('requestfailed', (r) => { if (r.url().includes('openfreemap')) tiles.fail++; });
  const t0 = Date.now();
  await p.goto(url);
  await p.waitForSelector('.maplibregl-canvas', { timeout: 30000 });
  try { await p.waitForSelector('.map-overlay', { state: 'detached', timeout: 45000 }); } catch { errs.push('overlay did not disappear in 45 s'); }
  const loadMs = Date.now() - t0;
  await p.waitForTimeout(6000);
  return { p, errs, tiles, loadMs };
}
const info = async (p) => p.evaluate(() => ({
  readout: document.querySelector('.map-readout')?.textContent,
  error: document.querySelector('.map-error')?.textContent ?? null,
  attrib: document.querySelector('.maplibregl-ctrl-attrib')?.textContent,
  scale: document.querySelector('.maplibregl-ctrl-scale')?.textContent,
  hscroll: document.documentElement.scrollWidth > innerWidth,
}));

const d = await open({ width: 1440, height: 900 }, 'http://localhost:4173/');
log('desktop load ms', d.loadMs, 'tiles', JSON.stringify(d.tiles));
log('desktop info', JSON.stringify(await info(d.p)));
await d.p.screenshot({ path: `${OUT}/01-desktop-3d.png` });
await d.p.click('text=План'); await d.p.waitForTimeout(3500);
await d.p.screenshot({ path: `${OUT}/02-desktop-plan.png` });
log('plan', JSON.stringify(await info(d.p)));
await d.p.click('text=3D'); await d.p.waitForTimeout(2500);
await d.p.click('[aria-label="Приблизить"]'); await d.p.waitForTimeout(800);
await d.p.click('[aria-label="Приблизить"]'); await d.p.waitForTimeout(800);
await d.p.click('[aria-label="Повернуть по часовой стрелке"]'); await d.p.waitForTimeout(5000);
await d.p.screenshot({ path: `${OUT}/03-desktop-zoom-rotate.png` });
log('zoomed', JSON.stringify(await info(d.p)));
for (let i = 0; i < 4; i++) { await d.p.click('[aria-label="Отдалить"]'); await d.p.waitForTimeout(500); }
await d.p.waitForTimeout(5000);
await d.p.screenshot({ path: `${OUT}/04-desktop-city.png` });
log('city', JSON.stringify(await info(d.p)));
await d.p.click('[aria-label="Вернуться к центру Бишкека"]'); await d.p.waitForTimeout(4000);
log('reset', JSON.stringify(await info(d.p)));
await d.p.click('.map-info summary'); await d.p.waitForTimeout(300);
await d.p.screenshot({ path: `${OUT}/05-desktop-info.png` });
await d.p.click('text=Лаборатория перекрёстка →'); await d.p.waitForTimeout(1000);
log('lab visible', await d.p.isVisible('text=Алгоритм управления'));
await d.p.screenshot({ path: `${OUT}/06-lab.png` });
log('desktop errors', JSON.stringify(d.errs, null, 1), 'tiles', JSON.stringify(d.tiles));

const m = await open({ width: 390, height: 844 }, 'http://localhost:4173/');
log('phone load ms', m.loadMs, 'info', JSON.stringify(await info(m.p)));
await m.p.screenshot({ path: `${OUT}/07-phone.png` });
log('phone errors', JSON.stringify(m.errs, null, 1));
await b.close();
