const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
let updateWorker = false;
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
  if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try {
    res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    let data = await readFile(path);
    if (updateWorker && path === resolve(root, 'sw.js')) {
      data = data.toString().replace(/const CACHE = '[^']+';/, "const CACHE = 'noodle-browser-update';");
    }
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    const Audio = window.AudioContext;
    window.__audioCalls = [];
    window.AudioContext = class extends Audio {
      constructor(options) { super(options); window.__audio = this; }
      createGain() {
        const gain = super.createGain();
        const connect = gain.connect.bind(gain);
        gain.connect = (destination, ...args) => {
          if (destination === this.destination) {
            window.__analyser = this.createAnalyser();
            connect(window.__analyser);
          }
          return connect(destination, ...args);
        };
        const target = gain.gain.setTargetAtTime.bind(gain.gain);
        gain.gain.setTargetAtTime = (...args) => {
          window.__audioCalls.push(['target', ...args]);
          return target(...args);
        };
        return gain;
      }
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelectorAll('.key').length === 15);
  assert.equal(await page.locator('.key').count(), 15);
  const pitches = await page.locator('.key').evaluateAll(pads => pads.map(p => p.getAttribute('aria-label')));
  assert.equal(new Set(pitches).size, 15);
  for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    const layout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth, inner: innerWidth,
      pads: [...document.querySelectorAll('.key')].map(p => ({ w: p.clientWidth, h: p.clientHeight })),
    }));
    assert.ok(layout.width <= layout.inner, JSON.stringify(layout));
    assert.ok(layout.pads.every(p => p.w >= 44 && p.h >= 44), JSON.stringify(layout));
    assert.deepEqual(await page.locator('.key').evaluateAll(pads => pads.map(p => p.getAttribute('aria-label'))), pitches);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await context.newCDPSession(page);
  const rect = await page.locator('.key').first().boundingBox();
  const point = (id, dx = 0) => ({ id, x: rect.x + rect.width / 2 + dx, y: rect.y + rect.height / 2 });
  const touches = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  await touches('touchStart', [point(1)]);
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => __audio.state), 'running');
  await touches('touchStart', [point(1), point(2, 5)]);
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.key.active').count(), 1);
  await touches('touchEnd', [point(2, 5)]);
  assert.equal(await page.locator('.key.active').count(), 1);
  await touches('touchEnd', []);
  assert.equal(await page.locator('.key.active').count(), 0);
  console.log('PASS unique pitches, mobile layouts, rotation, overlapping touches');

  await page.locator('#hold').tap();
  await page.locator('.key').first().tap();
  assert.equal(await page.locator('.key.active').count(), 1);
  await page.locator('.key').first().tap();
  assert.equal(await page.locator('.key.active').count(), 0);
  await page.locator('#hold').tap();
  await page.locator('#settings').tap();
  await page.locator('#release').fill('1.5');
  await page.locator('#tempo').fill('180');
  await page.locator('#tempo').dispatchEvent('change');
  await page.locator('#bars').selectOption('1');
  await page.locator('#close').tap();
  await page.locator('.key').first().tap();
  assert.ok(await page.evaluate(() => __audioCalls.some(c => c[0] === 'target' && c[1] === 0 && Math.abs(c[3] - .3) < .00001)));
  console.log('PASS latch toggle and release envelope');

  await page.evaluate(() => {
    document.querySelectorAll('.key').forEach(pad => pad.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
  });
  await page.waitForTimeout(120);
  await touches('touchStart', [point(10), point(11, 5)]);
  await page.waitForTimeout(150);
  await page.evaluate(() => document.querySelector('.key').dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true })));
  assert.ok(await page.evaluate(() => {
    const data = new Float32Array(__analyser.fftSize);
    __analyser.getFloatTimeDomainData(data);
    return data.some(sample => Math.abs(sample) > .001);
  }), 'Instrument must produce an audible signal after voice stealing');
  await touches('touchEnd', []);
  await page.locator('#panic').tap();
  assert.equal(await page.locator('.key.active').count(), 0);
  console.log('PASS bounded voice stealing and non-silent audio output');

  await page.locator('#record').tap();
  await page.waitForTimeout(120);
  await page.locator('.key').nth(3).tap();
  await page.waitForTimeout(150);
  await page.locator('.key').nth(5).tap();
  await page.waitForTimeout(1250);
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('prism-loop-v1')));
  assert.ok(saved.notes.length >= 2, JSON.stringify(saved));
  assert.equal(saved.tempo, 180);
  assert.equal(saved.bars, 1);
  assert.equal(await page.locator('#play').textContent(), 'Stop');
  const firstCount = saved.notes.length;
  await page.locator('#record').tap();
  await page.waitForFunction(() => document.querySelector('#record').textContent === 'Finish take');
  await page.locator('.key').nth(8).tap();
  await page.waitForTimeout(1450);
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('prism-loop-v1')));
  assert.ok(saved.notes.length > firstCount);
  await page.locator('#undo').tap();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('prism-loop-v1')).notes.length), firstCount);
  await page.locator('#clear').tap();
  assert.equal(await page.evaluate(() => localStorage.getItem('prism-loop-v1')), null);
  await page.locator('#undo').tap();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('prism-loop-v1')).notes.length), firstCount);
  console.log('PASS recording, overdub, undo and clear/restore');

  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#play').disabled);
  assert.equal(await page.locator('#play').textContent(), 'Play');
  await page.locator('#play').tap();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await page.locator('#play').textContent(), 'Play');
  assert.equal(await page.locator('.key.active').count(), 0);
  console.log('PASS saved-loop restore and interruption cleanup');

  await page.locator('#settings').tap();
  await page.locator('#arp').selectOption('bounce');
  await page.locator('#capture').tap();
  await page.locator('#close').tap();
  await page.locator('#hold').tap();
  await page.locator('.key').nth(4).tap();
  await page.locator('.key').nth(6).tap();
  await page.waitForTimeout(500);
  await page.locator('#panic').tap();
  await page.locator('#settings').tap();
  await page.locator('#capture').tap();
  await page.waitForFunction(() => !document.querySelector('#download').hidden);
  const blobSize = await page.locator('#download').evaluate(async a => (await (await fetch(a.href)).blob()).size);
  assert.ok(blobSize > 1000, `Recording size: ${blobSize}`);
  await page.locator('#close').tap();
  console.log('PASS arpeggiator and audio capture');
  await page.waitForFunction(() => __audio.state === 'suspended', null, { timeout: 8000 });
  await page.locator('.key').first().tap();
  await page.waitForFunction(() => __audio.state === 'running');
  console.log('PASS idle audio suspension and touch resume');

  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.key').length === 15);
  assert.equal(await page.locator('.key').count(), 15);
  await context.setOffline(false);
  console.log('PASS offline reload');
  updateWorker = true;
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
  await page.waitForFunction(() => !document.querySelector('#update').hidden);
  await page.locator('#update').tap();
  await page.waitForFunction(async () => (await caches.keys()).includes('noodle-browser-update') &&
    document.querySelectorAll('.key').length === 15 && document.querySelector('#update').hidden);
  assert.equal(await page.evaluate(async () => (await caches.keys()).some(key => key === 'prism-v2')), false);
  console.log('PASS explicit update activation and old-cache cleanup');
  assert.deepEqual(errors, []);
  console.log('PASS no uncaught browser errors');
  await context.close();
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
