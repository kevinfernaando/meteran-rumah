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
async function logMeter(page, { date, kwh, time = '23:59' }) {   // kwh = kWh left on the token meter
  await page.click('#tabHome');
  await page.check('#hModeBalance');
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
  assert.match(await text(page, '#histWrap'), /EV charge/);
  assert.equal(await text(page, '#kEvHome'), 'Rp 28.894'); // 20 kWh × Rp 1.444,70, same rate as the house
  await ctx.close();
});

test('household usage is the meter total minus home EV charging', async () => {
  const { ctx, page } = await freshPage();
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await logMeter(page, { date: today, time: '08:00', kwh: 200 });   // starting reading
  await logEv(page, { date: today, time: '14:00', kwh: 30 });
  await logMeter(page, { date: today, time: '23:59', kwh: 100 });   // 100 kWh used, 30 of it the car
  assert.match(await text(page, '#kHouseSub'), /^70,0 kWh/);
  assert.equal(await text(page, '#kHouse'), 'Rp 101.129'); // 70 × 1.444,70
  await ctx.close();
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
async function logToken(page, mode, { date, value, before, token, paid, time }) {
  await page.click('#tabHome');
  await page.check(mode === 'balance' ? '#hModeBalance' : '#hModeTopup');
  await page.fill('#hDate', date);
  if (time) await page.fill('#hTime', time);
  if (mode === 'balance') await page.fill('#hValue', String(value));
  else { if (before != null) await page.fill('#hValue', String(before)); await page.fill('#hToken', String(token)); }
  if (paid != null) await page.fill('#hPaid', String(paid));
  await page.click('#hSubmit');
}
const todayIn = (page) => page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });

test('token meter: usage is last remaining plus top-ups minus current remaining', async () => {
  const { ctx, page, errors } = await freshPage();
  const d = await todayIn(page);
  await logToken(page, 'balance', { date: d, value: 50 });                                // first reading = baseline
  await logToken(page, 'topup', { date: d, before: 30, token: 100, paid: 150000 });       // 50 − 30 = 20 used, meter now 130
  await logToken(page, 'balance', { date: d, value: 110 });                               // 130 − 110 = 20 used
  assert.match(await text(page, '#kTotalSub'), /^40,0 kWh/);
  const log = await text(page, '#histWrap');
  assert.match(log, /Token top-up/);
  assert.match(log, /Remaining 110 kWh/);
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
  const row = page.locator('#histWrap li', { hasText: 'Remaining 40 kWh' });
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
  await page.keyboard.press('Escape');
  await page.click('#settingsBtn'); await page.fill('#sPpj', '3'); await page.click('#sSubmit');
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
  assert.equal(await text(page, '#kTotal'), 'Rp 28.894');
  assert.match(await text(page, '#kTotalSub'), /^20,0 kWh/);
  assert.equal(await page.locator('#histWrap li').count(), 1);
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
  await logMeter(page, { date: m.prevFirst, time: '08:00', kwh: 300 });   // baseline
  await logEv(page, { date: m.prevLast, time: '22:30', kwh: 20 });
  await logMeter(page, { date: m.curFirst, time: '09:00', kwh: 200 });    // 100 kWh used
  assert.match(await text(page, '#kHouseSub'), /^80,0 kWh/);                              // 100 − 20 charged on the last day of last month
  await page.click('#prevMonth');
  assert.match(await text(page, '#kEvHomeSub'), /^20,0 kWh/);                            // the charge still costs last month
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the time of day decides which reading a same-day charge belongs to', async () => {
  const { ctx, page } = await freshPage();
  const d = await todayIn(page);
  await logMeter(page, { date: d, time: '08:00', kwh: 50 });            // starting balance
  await logEv(page, { date: d, time: '22:30', kwh: 10 });
  await logMeter(page, { date: d, time: '21:00', kwh: 25 });            // 25 used, charge is later
  assert.match(await text(page, '#kHouseSub'), /^25,0 kWh/);
  await logMeter(page, { date: d, time: '23:30', kwh: 10 });            // 15 used, 10 of it the car
  assert.match(await text(page, '#kHouseSub'), /^30,0 kWh/);                              // 25 + (15 − 10)
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
  assert.equal(await text(page, '#kEvHome'), 'Rp 56.733');            // 39,27 × 1.444,70
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
  await page.click('#settingsBtn');
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

/* ---------- two-step charging: start now, finish when unplugging ---------- */
async function startCharge(page, { date, time, from }) {
  await page.click('#tabEv');
  await page.check('#eModeSoc');
  await page.fill('#eDate', date); await page.fill('#eTime', time);
  await page.fill('#eSocFrom', String(from));
  await page.click('#eSubmit');
}

test('a charge can be started with only the battery before, and finished later with the battery after', async () => {
  const { ctx, page, errors } = await freshPage();
  const d = await todayIn(page);
  await startCharge(page, { date: d, time: '22:30', from: 20 });
  assert.match(await text(page, '#histWrap'), /Your log is empty/);          // not counted until it's finished
  await page.reload();                                                       // e.g. coming back in the morning
  assert.match(await text(page, '#notice'), /charging since 22:30/i);
  await page.click('#tabEv');
  assert.match(await text(page, '#eActive'), /20%/);
  await page.fill('#eFinishTo', '80');
  await page.click('#eFinish');
  assert.match(await text(page, '#kEvHomeSub'), /^39,3 kWh/);                // same as logging 20% → 80% in one go
  assert.equal(await text(page, '#kEvHome'), 'Rp 56.733');                  // same as logging it in one go
  assert.match(await text(page, '#histWrap'), /20% → 80%/);
  assert.equal(await page.locator('#eActive').isHidden(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('finishing below the starting battery is refused and the session stays open', async () => {
  const { ctx, page } = await freshPage();
  const d = await todayIn(page);
  await startCharge(page, { date: d, time: '22:30', from: 60 });
  await page.fill('#eFinishTo', '50');
  await page.click('#eFinish');
  assert.match(await text(page, '#eStatus'), /higher than/i);
  assert.equal(await page.locator('#eActive').isVisible(), true);
  await ctx.close();
});

test('an open charging session can be discarded', async () => {
  const { ctx, page } = await freshPage();
  const d = await todayIn(page);
  await startCharge(page, { date: d, time: '22:30', from: 30 });
  await page.click('#eDiscard'); await page.click('#eDiscard');               // second tap confirms
  assert.equal(await page.locator('#eActive').isHidden(), true);
  await page.reload();
  assert.doesNotMatch(await text(page, '#notice'), /charging since/i);
  assert.match(await text(page, '#histWrap'), /Your log is empty/);
  await ctx.close();
});

/* ---------- home meter = meter readings + token top-ups ---------- */
test('the home meter only offers meter readings and token top-ups', async () => {
  const { ctx, page } = await freshPage();
  await page.click('#tabHome');
  assert.equal(await page.locator('input[name="hMode"]').count(), 2);
  assert.equal(await page.locator('#hModeKwh, #hModeMeter').count(), 0);
  assert.match(await text(page, '#formHome'), /Meter reading/);
  assert.match(await text(page, '#formHome'), /Token top-up/);
  await ctx.close();
});

test('a top-up needs the kWh left before topping up', async () => {
  const { ctx, page } = await freshPage();
  const d = await todayIn(page);
  await logToken(page, 'topup', { date: d, token: 100 });
  assert.match(await text(page, '#hStatus'), /before/i);
  assert.match(await text(page, '#histWrap'), /Your log is empty/);
  await ctx.close();
});

test('usage is measured from one top-up to the next', async () => {
  const { ctx, page, errors } = await freshPage();
  const d = await todayIn(page);
  await logToken(page, 'topup', { date: d, time: '08:00', before: 40, token: 100 });   // first entry: starting point, meter now 140
  await logToken(page, 'topup', { date: d, time: '12:00', before: 60, token: 100 });   // 140 − 60 = 80 used, meter now 160
  await logToken(page, 'balance', { date: d, time: '20:00', value: 150 });             // 10 used
  assert.match(await text(page, '#kTotalSub'), /^90,0 kWh/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a top-up whose kWh before is higher than expected is refused', async () => {
  const { ctx, page } = await freshPage();
  const d = await todayIn(page);
  await logToken(page, 'balance', { date: d, time: '08:00', value: 50 });
  await logToken(page, 'topup', { date: d, time: '09:00', before: 70, token: 100 });
  assert.match(await text(page, '#hStatus'), /higher than/i);
  assert.doesNotMatch(await text(page, '#histWrap'), /Token top-up/);
  await ctx.close();
});

test('entries saved with the old "kWh used" option still count', async () => {
  const { ctx, page } = await freshPage();
  const d = await todayIn(page);
  await page.evaluate((d) => localStorage.setItem('meteran-rumah.v1', JSON.stringify({ version: 1, settings: { homeMode: 'kwh' }, usage: [
    { id: 'old', date: d, time: '23:59', kwh: 42, createdAt: d + 'T01:00:00Z' } ], charges: [] })), d);
  await page.reload();
  assert.match(await text(page, '#kHouseSub'), /^42,0 kWh/);
  await ctx.close();
});

/* ---------- no night discount: the car charges on the home token meter ---------- */
test('charging costs the same per kWh at any time of day', async () => {
  const { ctx, page } = await freshPage();
  const d = await todayIn(page);
  await logEv(page, { date: d, time: '22:30', kwh: 10 });
  await logEv(page, { date: d, time: '14:00', kwh: 10 });
  assert.equal(await text(page, '#kEvHome'), 'Rp 28.894');               // 20 × 1.444,70, no discount for either
  assert.doesNotMatch(await page.locator('body').innerText(), /night|discount/i);
  assert.equal(await page.locator('#sDisc, #sFrom, #sTo').count(), 0);
  await ctx.close();
});

/* ---------- mobile layout: bottom actions and sheets ---------- */
test('saving from a sheet closes it and confirms what was saved', async () => {
  const { ctx, page } = await freshPage({ viewport: { width: 390, height: 844 } });
  const d = await todayIn(page);
  await page.click('#tabHome');
  assert.equal(await page.locator('#sheetHome').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sheetHome').isHidden(), true);
  await logToken(page, 'topup', { date: d, before: 40, token: 100 });
  assert.equal(await page.locator('#sheetHome').isHidden(), true);
  assert.match(await text(page, '#toast'), /saved/i);
  await ctx.close();
});

test('while a charge is open the bottom button offers to finish it', async () => {
  const { ctx, page } = await freshPage({ viewport: { width: 390, height: 844 } });
  const d = await todayIn(page);
  await startCharge(page, { date: d, time: '22:30', from: 20 });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sheetEv').isHidden(), true);
  assert.match(await text(page, '#tabEv'), /Finish charging/);
  await ctx.close();
});

test('settings explain that each device keeps its own copy of the data', async () => {
  const { ctx, page } = await freshPage({ viewport: { width: 390, height: 844 } });
  await page.click('#settingsBtn');
  assert.match(await text(page, '#sheetSettings'), /this device/i);
  await ctx.close();
});

/* ---------- calmer layout ---------- */
test('the summary has no explanation note under it', async () => {
  const { ctx, page } = await freshPage({ viewport: { width: 390, height: 844 } });
  await page.click('#loadExamples');
  assert.equal(await page.locator('#bdHint').count(), 0);
  assert.doesNotMatch(await page.locator('main').innerText(), /Household = meter/);
  await ctx.close();
});

test('Charge car is the primary button and both labels are centred', async () => {
  const { ctx, page } = await freshPage({ viewport: { width: 390, height: 844 } });
  assert.match(await page.getAttribute('#tabEv', 'class'), /act-primary/);
  assert.doesNotMatch(await page.getAttribute('#tabHome', 'class'), /act-primary/);
  for (const id of ['#tabEv', '#tabHome']) assert.equal(await page.$eval(id, (b) => getComputedStyle(b).textAlign), 'center');
  await ctx.close();
});

test('chart axis labels stay inside the chart', async () => {
  const { ctx, page } = await freshPage({ viewport: { width: 390, height: 844 } });
  await page.click('#loadExamples');
  await page.evaluate(() => document.fonts.ready);
  const out = await page.$$eval('#trendChart .axis text', (ts) => {
    const box = document.querySelector('#trendChart').getBoundingClientRect();
    return ts.filter((t) => { const r = t.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5; }).map((t) => t.textContent);
  });
  assert.deepEqual(out, []);
  await ctx.close();
});

test('settings no longer has a backup section', async () => {
  const { ctx, page } = await freshPage({ viewport: { width: 390, height: 844 } });
  await page.click('#settingsBtn');
  assert.equal(await page.locator('#exportBtn, #importFile, #importStatus').count(), 0);
  assert.doesNotMatch(await page.locator('#sheetSettings').innerText(), /backup/i);
  await ctx.close();
});

/* ---------- monthly / daily chart ---------- */
const prevMonthDay = (page, day) => page.evaluate((day) => {
  const n = new Date(), d = new Date(n.getFullYear(), n.getMonth() - 1, day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}, day);

test('the chart can switch to a daily view of the selected month', async () => {
  const { ctx, page, errors } = await freshPage({ viewport: { width: 390, height: 844 } });
  await page.click('#loadExamples');
  assert.equal(await page.getAttribute('#viewMonthly', 'aria-pressed'), 'true');
  assert.equal(await page.locator('#trendChart .hit').count(), 6);                       // six months
  await page.click('#viewDaily');
  const days = await page.evaluate(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate(); });
  assert.equal(await page.locator('#trendChart .hit').count(), days);                    // one column per day
  assert.match(await text(page, '#trendTitle'), /Daily/);
  await page.click('#viewMonthly');
  assert.equal(await page.locator('#trendChart .hit').count(), 6);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('daily view spreads household use between readings across the days in between', async () => {
  const { ctx, page } = await freshPage({ viewport: { width: 390, height: 844 } });
  const d1 = await prevMonthDay(page, 1), d5 = await prevMonthDay(page, 5), d2 = await prevMonthDay(page, 2);
  await logMeter(page, { date: d1, time: '00:00', kwh: 300 });
  await logEv(page, { date: d2, time: '21:00', kwh: 20 });
  await logMeter(page, { date: d5, time: '00:00', kwh: 180 });     // 120 used, 20 of it the car → 100 household over 4 days
  // saving an entry already shows that entry's month
  await page.click('[data-unit="kwh"]');
  await page.click('#viewDaily');
  const tipFor = async (i) => { await page.locator('#trendChart .hit').nth(i).dispatchEvent('pointerenter'); return text(page, '#trendChart .tip'); };
  const day2 = await tipFor(1);
  assert.match(day2, /Household\s*25,0 kWh/);
  assert.match(day2, /EV charging\s*20,0 kWh/);
  assert.match(await tipFor(3), /Household\s*25,0 kWh/);
  assert.match(await tipFor(4), /Household\s*0,0 kWh/);
  await ctx.close();
});

test('the chosen chart view is remembered on the device', async () => {
  const { ctx, page } = await freshPage({ viewport: { width: 390, height: 844 } });
  await page.click('#viewDaily');
  await page.reload();
  assert.equal(await page.getAttribute('#viewDaily', 'aria-pressed'), 'true');
  await ctx.close();
});
