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

async function logEv(page, { date, time, kwh }) {
  await page.click('#tabEv');
  await page.check('#eModeKwh');
  await page.fill('#eDate', date); await page.fill('#eTime', time); await page.fill('#eKwh', String(kwh));
  await page.click('#eSubmit');
}
async function logMeter(page, { date, kwh, time = '23:59', mode = 'kwh' }) {
  await page.click('#tabHome');
  await page.check(mode === 'kwh' ? '#hModeKwh' : mode === 'meter' ? '#hModeMeter' : '#hModeBalance');
  await page.fill('#hDate', date); await page.fill('#hTime', time); await page.fill('#hValue', String(kwh));
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

/* ---------- prepaid token meter ---------- */
async function logToken(page, mode, { date, value, paid }) {
  await page.click('#tabHome');
  await page.check(mode === 'balance' ? '#hModeBalance' : '#hModeTopup');
  await page.fill('#hDate', date); await page.fill('#hValue', String(value));
  if (paid != null) await page.fill('#hPaid', String(paid));
  await page.click('#hSubmit');
}
const todayIn = (page) => page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });

test('token meter: usage is last remaining plus top-ups minus current remaining', async () => {
  const { ctx, page, errors } = await freshPage();
  const d = await todayIn(page);
  await logToken(page, 'balance', { date: d, value: 50 });          // first reading = baseline
  await logToken(page, 'topup', { date: d, value: 100, paid: 150000 });
  await logToken(page, 'balance', { date: d, value: 120 });         // 50 + 100 − 120 = 30
  assert.match(await text(page, '#kTotalSub'), /^30,0 kWh/);
  const log = await text(page, '#histWrap');
  assert.match(log, /Token top-up/);
  assert.match(log, /Remaining 120 kWh/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('token meter: deleting a reading recalculates usage from the readings left', async () => {
  const { ctx, page } = await freshPage();
  const d = await todayIn(page);
  await logToken(page, 'balance', { date: d, value: 50 });
  await logToken(page, 'balance', { date: d, value: 40 });
  await logToken(page, 'balance', { date: d, value: 25 });
  assert.match(await text(page, '#kTotalSub'), /^25,0 kWh/);
  const row = page.locator('#histWrap tr', { hasText: 'Remaining 40 kWh' });
  await row.locator('.del').click(); await row.locator('.del').click();
  assert.match(await text(page, '#kTotalSub'), /^25,0 kWh/);     // 50 − 25, still 25
  assert.doesNotMatch(await text(page, '#histWrap'), /Remaining 40 kWh/);
  await ctx.close();
});

test('token meter: a remaining balance that went up without a top-up is refused', async () => {
  const { ctx, page } = await freshPage();
  const d = await todayIn(page);
  await logToken(page, 'balance', { date: d, value: 50 });
  await logToken(page, 'balance', { date: d, value: 80 });
  assert.match(await text(page, '#hStatus'), /top-up/i);
  assert.doesNotMatch(await text(page, '#histWrap'), /Remaining 80 kWh/);
  await ctx.close();
});

test('the home meter entry type is remembered after a reload', async () => {
  const { ctx, page } = await freshPage();
  await page.click('#tabHome'); await page.check('#hModeBalance');
  await page.reload();
  assert.equal(await page.isChecked('#hModeBalance'), true);
  await ctx.close();
});

test('saving tariff settings keeps the remembered home meter entry type', async () => {
  const { ctx, page } = await freshPage();
  await page.click('#tabHome'); await page.check('#hModeBalance');
  await page.click('#settingsBox summary'); await page.fill('#sPpj', '3'); await page.click('#sSubmit');
  await page.reload();
  assert.equal(await page.isChecked('#hModeBalance'), true);
  await ctx.close();
});

/* ---------- house-only: no public charging ---------- */
test('public SPKLU charging is gone from the page', async () => {
  const { ctx, page } = await freshPage();
  assert.equal(await page.locator('#ePlacePub, #ePrice, #kEvPub, #sPub').count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /SPKLU|public/i);
  await ctx.close();
});

test('example data only has charging at home', async () => {
  const { ctx, page } = await freshPage();
  await page.click('#loadExamples');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('meteran-rumah.v1')));
  assert.ok(stored.charges.length > 0);
  assert.equal(stored.charges.filter((c) => c.place === 'public').length, 0);
  await ctx.close();
});

test('public sessions saved by an older version are left out of totals', async () => {
  const { ctx, page } = await freshPage();
  const d = await todayIn(page);
  await page.evaluate((d) => localStorage.setItem('meteran-rumah.v1', JSON.stringify({ version: 1, settings: {}, usage: [], charges: [
    { id: 'a', date: d, time: '22:30', kwh: 20, place: 'home', createdAt: d + 'T01:00:00Z' },
    { id: 'b', date: d, time: '13:00', kwh: 25, place: 'public', pricePerKwh: 2467, createdAt: d + 'T02:00:00Z' },
  ] })), d);
  await page.reload();
  assert.equal(await text(page, '#kTotal'), 'Rp 20.226');
  assert.match(await text(page, '#kTotalSub'), /^20,0 kWh/);
  assert.equal(await page.locator('#histWrap tbody tr').count(), 1);
  await ctx.close();
});

/* ---------- per-interval subtraction ---------- */
const monthDates = (page) => page.evaluate(() => {
  const f = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  return { prevFirst: f(new Date(now.getFullYear(), now.getMonth() - 1, 1)), prevLast: f(new Date(now.getFullYear(), now.getMonth(), 0)), curFirst: f(new Date(now.getFullYear(), now.getMonth(), 1)) };
});

test('charging between two readings is subtracted from the later reading, even across months', async () => {
  const { ctx, page, errors } = await freshPage();
  const m = await monthDates(page);
  await logMeter(page, { date: m.prevFirst, time: '08:00', kwh: 1000, mode: 'meter' });   // baseline
  await logEv(page, { date: m.prevLast, time: '22:30', kwh: 20 });
  await logMeter(page, { date: m.curFirst, time: '09:00', kwh: 1100, mode: 'meter' });    // 100 kWh used
  assert.match(await text(page, '#kHouseSub'), /^80,0 kWh/);                              // 100 − 20 charged on the last day of last month
  await page.click('#prevMonth');
  assert.match(await text(page, '#kEvHomeSub'), /^20,0 kWh/);                            // the charge still costs last month
  assert.doesNotMatch(await text(page, '#bdHint'), /higher than the meter/i);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the time of day decides which reading a same-day charge belongs to', async () => {
  const { ctx, page } = await freshPage();
  const d = await todayIn(page);
  await logMeter(page, { date: d, time: '08:00', kwh: 50, mode: 'balance' });            // starting balance
  await logEv(page, { date: d, time: '22:30', kwh: 10 });
  await logMeter(page, { date: d, time: '21:00', kwh: 25, mode: 'balance' });            // 25 used, charge is later
  assert.match(await text(page, '#kHouseSub'), /^25,0 kWh/);
  assert.match(await text(page, '#bdHint'), /10,0 kWh of charging since your last reading/);
  await logMeter(page, { date: d, time: '23:30', kwh: 10, mode: 'balance' });            // 15 used, 10 of it the car
  assert.match(await text(page, '#kHouseSub'), /^30,0 kWh/);                              // 25 + (15 − 10)
  assert.doesNotMatch(await text(page, '#bdHint'), /since your last reading/);
  await ctx.close();
});

/* ---------- EV charging by battery percentage ---------- */
async function logSoc(page, { date, time, from, to }) {
  await page.click('#tabEv');
  await page.check('#eModeSoc');
  await page.fill('#eDate', date); await page.fill('#eTime', time);
  await page.fill('#eSocFrom', String(from)); await page.fill('#eSocTo', String(to));
  await page.click('#eSubmit');
}

test('battery percentages are turned into kWh drawn from the meter for a Jaecoo J5 EV', async () => {
  const { ctx, page, errors } = await freshPage();
  const d = await todayIn(page);
  await logSoc(page, { date: d, time: '22:30', from: 20, to: 80 });
  // 60% of 58,9 kWh usable = 35,34 kWh into the battery; at 90% charging efficiency ≈ 39,27 kWh from the meter
  assert.match(await text(page, '#kEvHomeSub'), /^39,3 kWh/);
  assert.equal(await text(page, '#kEvHome'), 'Rp 39.713');            // 39,27 × 1.444,70 × 0,7 night rate
  assert.match(await text(page, '#histWrap'), /20% → 80%/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a charge that ends lower than it started is refused', async () => {
  const { ctx, page } = await freshPage();
  const d = await todayIn(page);
  await logSoc(page, { date: d, time: '22:30', from: 70, to: 40 });
  assert.match(await text(page, '#eStatus'), /higher than/i);
  assert.match(await text(page, '#histWrap'), /Your log is empty/);
  await ctx.close();
});

test('battery size and charging efficiency can be changed in settings', async () => {
  const { ctx, page } = await freshPage();
  await page.click('#settingsBox summary');
  await page.fill('#sBattery', '50'); await page.fill('#sEff', '100'); await page.click('#sSubmit');
  const d = await todayIn(page);
  await logSoc(page, { date: d, time: '22:30', from: 10, to: 60 });   // 50% of 50 kWh at 100%
  assert.match(await text(page, '#kEvHomeSub'), /^25,0 kWh/);
  await ctx.close();
});

test('battery percentage is the default way to log a charge', async () => {
  const { ctx, page } = await freshPage();
  await page.click('#tabEv');
  assert.equal(await page.isChecked('#eModeSoc'), true);
  await ctx.close();
});
