// Shared-household sync tests, run against an in-memory stand-in for the Supabase functions in supabase.sql.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const API = 'https://sync.test';
let server, base, browser;

before(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0].split('#')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

// Mirrors public.pull / public.push from supabase.sql.
function fakeSupabase() {
  const households = new Set(), rows = new Map();
  let tick = Date.parse('2026-01-01T00:00:00Z');
  const stamp = () => new Date(tick += 1000).toISOString();
  return {
    households, rows,
    list: (code) => [...rows.values()].filter((r) => r.household === code),
    handle(fn, body) {
      if (!households.has(body.p_code)) return { status: 400, json: { code: 'P0001', message: 'Unknown household code' } };
      if (fn === 'pull') {
        const out = [...rows.values()].filter((r) => r.household === body.p_code && (!body.p_since || r.updated_at > body.p_since))
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
        return { status: 200, json: out };
      }
      if (fn === 'push') {
        for (const r of body.p_rows) rows.set(body.p_code + '|' + r.id, { household: body.p_code, id: r.id, kind: r.kind, data: r.data ?? null, deleted: !!r.deleted, updated_at: stamp() });
        return { status: 200, json: new Date(tick).toISOString() };
      }
      return { status: 404, json: { message: 'no such function' } };
    },
  };
}

async function device(db, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...opts });
  await ctx.route('**/config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: `window.METERAN_CONFIG = { supabaseUrl: "${API}", supabaseKey: "anon-test-key" };` }));
  await ctx.route(API + '/**', async (route) => {
    const req = route.request();
    const fn = new URL(req.url()).pathname.split('/').pop();
    if (req.headers()['apikey'] !== 'anon-test-key') return route.fulfill({ status: 401, json: { message: 'No API key' } });
    const { status, json } = db.handle(fn, JSON.parse(req.postData() || '{}'));
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}
const text = async (page, sel) => (await page.locator(sel).innerText()).replace(/ /g, ' ');
const until = async (cond, ms = 5000) => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };
const todayIn = (page) => page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
async function topUp(page, { before, token, time = '08:00' }) {
  await page.click('#tabHome'); await page.check('#hModeTopup');
  await page.fill('#hDate', await todayIn(page)); await page.fill('#hTime', time);
  await page.fill('#hValue', String(before)); await page.fill('#hToken', String(token));
  await page.click('#hSubmit');
}
async function charge(page, { kwh, time = '14:00' }) {
  await page.click('#tabEv'); await page.check('#eModeKwh');
  await page.fill('#eDate', await todayIn(page)); await page.fill('#eTime', time); await page.fill('#eKwh', String(kwh));
  await page.click('#eSubmit');
}
const CODE = 'family-7f3k-92qx-ab41';

test('devices that open the household link share entries and settings', async () => {
  const db = fakeSupabase(); db.households.add(CODE);
  const a = await device(db);
  await a.page.goto(base + '#join=' + CODE);
  await topUp(a.page, { before: 40, token: 100 });
  await a.page.click('#settingsBtn'); await a.page.selectOption('#sPreset', '1699.53'); await a.page.click('#sSubmit');
  await until(() => db.list(CODE).some((r) => r.kind === 'settings' && r.data.tariff === 1699.53) && db.list(CODE).some((r) => r.kind === 'usage'));

  const b = await device(db);
  await b.page.goto(base + '#join=' + CODE);
  await b.page.waitForFunction(() => document.querySelector('#histWrap').innerText.includes('Token top-up'));
  await b.page.click('#settingsBtn');
  assert.equal(await b.page.inputValue('#sPreset'), '1699.53');
  assert.match(await text(b.page, '#syncStatus'), /connected/i);
  assert.deepEqual([...a.errors, ...b.errors], []);
  await a.ctx.close(); await b.ctx.close();
});

test('the join link is taken out of the address bar and remembered on the device', async () => {
  const db = fakeSupabase(); db.households.add(CODE);
  const a = await device(db);
  await a.page.goto(base + '#join=' + CODE);
  await until(async () => (await a.page.evaluate(() => location.hash)) === '');
  await a.page.reload();
  await a.page.click('#settingsBtn');
  assert.match(await text(a.page, '#syncStatus'), /connected/i);
  await a.ctx.close();
});

test('a deletion on one device disappears on the others', async () => {
  const db = fakeSupabase(); db.households.add(CODE);
  const a = await device(db), b = await device(db);
  await a.page.goto(base + '#join=' + CODE);
  await charge(a.page, { kwh: 12 });
  await until(() => db.list(CODE).some((r) => r.kind === 'charge' && !r.deleted));
  await b.page.goto(base + '#join=' + CODE);
  await b.page.waitForFunction(() => document.querySelector('#histWrap').innerText.includes('EV charge'));
  const del = a.page.locator('#histWrap .del').first();
  await del.click(); await del.click();
  await until(() => db.list(CODE).some((r) => r.kind === 'charge' && r.deleted));
  await b.page.reload();
  await b.page.waitForFunction(() => !document.querySelector('#histWrap').innerText.includes('EV charge'));
  await a.ctx.close(); await b.ctx.close();
});

test('a device joining keeps its own entries and takes the household settings', async () => {
  const db = fakeSupabase(); db.households.add(CODE);
  db.rows.set(CODE + '|settings', { household: CODE, id: 'settings', kind: 'settings', data: { tariff: 1699.53, preset: '1699.53', ppj: 3, batteryKwh: 58.9, chargeEff: 90 }, deleted: false, updated_at: '2026-01-01T00:00:01.000Z' });
  const a = await device(db);
  await a.page.goto(base);
  await charge(a.page, { kwh: 10 });                                     // logged before joining
  await a.page.goto(base + '#join=' + CODE);
  await until(() => db.list(CODE).some((r) => r.kind === 'charge'));     // its entry went up
  await a.page.click('#settingsBtn');
  assert.equal(await a.page.inputValue('#sPpj'), '3');                  // household settings won
  await a.ctx.close();
});

test('an unknown household code is refused and not remembered', async () => {
  const db = fakeSupabase(); db.households.add(CODE);
  const a = await device(db);
  await a.page.goto(base + '#join=not-our-house-code');
  await a.page.click('#settingsBtn');
  await a.page.waitForFunction(() => /recogni/i.test(document.querySelector('#syncStatus').innerText));
  await a.page.reload();
  await a.page.click('#settingsBtn');
  assert.doesNotMatch(await text(a.page, '#syncStatus'), /connected/i);
  await a.ctx.close();
});

test('a code can be typed in settings to join', async () => {
  const db = fakeSupabase(); db.households.add(CODE);
  const a = await device(db);
  await a.page.goto(base);
  await a.page.click('#settingsBtn');
  await a.page.fill('#syncCode', CODE); await a.page.click('#syncConnect');
  await a.page.waitForFunction(() => /connected/i.test(document.querySelector('#syncStatus').innerText));
  await a.ctx.close();
});

test('entries logged while offline are sent once the connection is back', async () => {
  const db = fakeSupabase(); db.households.add(CODE);
  const a = await device(db);
  await a.page.goto(base + '#join=' + CODE);
  await a.page.click('#settingsBtn');
  await a.page.waitForFunction(() => /connected/i.test(document.querySelector('#syncStatus').innerText));
  await a.page.keyboard.press('Escape');
  await a.ctx.setOffline(true);
  await charge(a.page, { kwh: 8 });
  assert.equal(db.list(CODE).filter((r) => r.kind === 'charge').length, 0);
  await a.ctx.setOffline(false);
  await a.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(() => db.list(CODE).some((r) => r.kind === 'charge'));
  await a.ctx.close();
});

test('a background sync does not undo a settings edit that is not saved yet', async () => {
  const db = fakeSupabase(); db.households.add(CODE);
  const a = await device(db);
  await a.page.goto(base + '#join=' + CODE);
  await a.page.click('#settingsBtn');
  await a.page.waitForFunction(() => /connected/i.test(document.querySelector('#syncStatus').innerText));
  await a.page.selectOption('#sPreset', '1699.53');
  db.rows.set(CODE + '|settings', { household: CODE, id: 'settings', kind: 'settings', data: { tariff: 1352, preset: '1352', ppj: 0, batteryKwh: 58.9, chargeEff: 90 }, deleted: false, updated_at: '2030-01-01T00:00:00.000Z' });
  await a.page.evaluate(() => window.dispatchEvent(new Event('online')));          // a sync runs while the sheet is open
  await until(async () => (await a.page.locator('#syncState').innerText()) === 'synced');
  assert.equal(await a.page.inputValue('#sPreset'), '1699.53');
  await a.ctx.close();
});
