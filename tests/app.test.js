// Browser tests for Meteran Rumah. Run: npm test  (needs Playwright + Chromium installed)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
let server, base, browser;

before(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    const type = { '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }); fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function freshPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  return { ctx, page, errors };
}
const text = async (page, sel) => (await page.locator(sel).innerText()).replace(/\u00a0/g, ' ');

async function logEv(page, { date, time, kwh, place = 'home' }) {
  await page.click('#tabEv');
  await page.check(place === 'home' ? '#ePlaceHome' : '#ePlacePub');
  await page.fill('#eDate', date); await page.fill('#eTime', time); await page.fill('#eKwh', String(kwh));
  await page.click('#eSubmit');
}
async function logMeter(page, { date, kwh }) {
  await page.click('#tabHome');
  await page.check('#hModeKwh');
  await page.fill('#hDate', date); await page.fill('#hValue', String(kwh));
  await page.click('#hSubmit');
}

test('a new visitor sees an empty log and can load example data', async () => {
  const { ctx, page, errors } = await freshPage();
  assert.match(await text(page, '#histWrap'), /Your log is empty/);
  await page.click('#loadExamples');
  assert.notEqual(await text(page, '#kTotal'), 'Rp 0');
  assert.match(await text(page, '#notice'), /example entries/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('entries are saved in the browser and survive a reload', async () => {
  const { ctx, page } = await freshPage();
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await logEv(page, { date: today, time: '22:30', kwh: 20 });
  await page.reload();
  assert.match(await text(page, '#histWrap'), /EV home/);
  assert.equal(await text(page, '#kEvHome'), 'Rp 20.226'); // 20 kWh × Rp 1.444,70 × (1 − 30% night discount)
  await ctx.close();
});

test('household usage is the meter total minus home EV charging', async () => {
  const { ctx, page } = await freshPage();
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await logMeter(page, { date: today, kwh: 100 });
  await logEv(page, { date: today, time: '14:00', kwh: 30 });
  assert.match(await text(page, '#kHouseSub'), /^70,0 kWh/);
  assert.equal(await text(page, '#kHouse'), 'Rp 101.129'); // 70 × 1.444,70
  await ctx.close();
});

test('export downloads a JSON backup that import restores in another browser', async () => {
  const a = await freshPage();
  const today = await a.page.evaluate(() => new Date().toISOString().slice(0, 10));
  await logEv(a.page, { date: today, time: '23:00', kwh: 12.5 });
  const [dl] = await Promise.all([a.page.waitForEvent('download'), a.page.click('#exportBtn')]);
  const file = path.join(require('node:os').tmpdir(), `meteran-backup-${Date.now()}.json`);
  await dl.saveAs(file); // keep a copy: Playwright deletes downloads when the browser closes
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(backup.charges.length, 1);
  assert.equal(backup.charges[0].kwh, 12.5);
  await a.ctx.close();

  const b = await freshPage();
  await b.page.setInputFiles('#importFile', file);
  await b.page.waitForFunction(() => document.querySelector('#histWrap').innerText.includes('EV home'));
  assert.match(await text(b.page, '#importStatus'), /Imported 1 entr/);
  await b.ctx.close();
});

test('clearing examples keeps the entries you logged yourself', async () => {
  const { ctx, page } = await freshPage();
  await page.click('#loadExamples');
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await logEv(page, { date: today, time: '22:00', kwh: 10 });
  await page.click('#notice button');
  assert.equal(await page.locator('#notice').isHidden(), true);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('meteran-rumah.v1')));
  assert.equal(stored.charges.length, 1);
  assert.equal(stored.usage.length, 0);
  await ctx.close();
});

test('the page fits a phone screen without sideways scrolling', async () => {
  const { ctx, page } = await freshPage({ viewport: { width: 390, height: 844 } });
  await page.click('#loadExamples');
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 390, `page is ${w}px wide`);
  await ctx.close();
});
