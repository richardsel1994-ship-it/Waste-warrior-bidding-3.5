const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let app, server, base, dir;
const stripeCalls = [];
const fakeStripe = {
  checkout: {
    sessions: {
      create: async (p) => { stripeCalls.push(p); return { id: 'cs_test_1', url: 'https://checkout.stripe.com/pay/cs_test_1' }; },
      retrieve: async () => ({ id: 'cs_test_1', payment_status: 'paid' }),
    },
  },
  webhooks: { constructEvent: () => { throw new Error('bad'); } },
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwb-'));
  app = createApp({ dataDir: dir, jwtSecret: 'test', stripe: fakeStripe });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function api(method, url, { body, cookie, form } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) payload = form;
  else if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const register = async (n) => (await api('POST', '/api/auth/register', { body: { email: `${n}@x.com`, name: n + ' user', password: 'password123' } }));

function listingForm(over = {}, png = PNG) {
  const f = new FormData();
  const d = { title: 'Clean PET bottles', description: 'Sorted and rinsed bottles', category: 'Plastic', qtyKg: '100', location: 'Leeds', startPrice: '10', durationHours: '24', ...over };
  for (const [k, v] of Object.entries(d)) f.append(k, v);
  if (png) f.append('images', new Blob([png], { type: 'image/png' }), 'a.png');
  return f;
}

test('auth: register, duplicate, login, bad password', async () => {
  const r = await register('alice');
  assert.equal(r.status, 201);
  assert.ok(r.cookie.startsWith('token='));
  assert.equal((await register('alice')).status, 409);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'alice@x.com', password: 'nope' } })).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'alice@x.com', password: 'password123' } })).status, 200);
  assert.equal((await api('POST', '/api/auth/register', { body: { email: 'bad', name: 'x', password: 'short' } })).status, 400);
});

test('listing creation needs auth, photo, and a real image', async () => {
  const s = (await register('seller1')).cookie;
  assert.equal((await api('POST', '/api/listings', { form: listingForm() })).status, 401);
  assert.equal((await api('POST', '/api/listings', { cookie: s, form: listingForm({}, null) })).status, 400);
  assert.equal((await api('POST', '/api/listings', { cookie: s, form: listingForm({}, Buffer.from('<script>alert(1)</script>')) })).status, 400);
  assert.equal((await api('POST', '/api/listings', { cookie: s, form: listingForm({ startPrice: '0.5' }) })).status, 400);
  const ok = await api('POST', '/api/listings', { cookie: s, form: listingForm() });
  assert.equal(ok.status, 201);
  const got = await api('GET', `/api/listings/${ok.json.id}`);
  assert.equal(got.json.listing.images.length, 1);
  const img = await fetch(`${base}/uploads/${got.json.listing.images[0]}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
});

test('bidding rules, auction end, payment flow', async () => {
  const seller = (await register('seller2')).cookie;
  const b1 = (await register('bidder1')).cookie;
  const b2 = (await register('bidder2')).cookie;
  const { json: { id } } = await api('POST', '/api/listings', { cookie: seller, form: listingForm({ startPrice: '10' }) });

  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: seller, body: { amount: 20 } })).status, 403);
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { body: { amount: 20 } })).status, 401);
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: b1, body: { amount: 5 } })).status, 409);
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: b1, body: { amount: 10 } })).status, 201);
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: b1, body: { amount: 50 } })).status, 409); // already leading
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: b2, body: { amount: 10.2 } })).status, 409); // under increment
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: b2, body: { amount: 12.5 } })).status, 201);

  // can't pay while open (no winner yet)
  assert.equal((await api('POST', `/api/listings/${id}/checkout`, { cookie: b2 })).status, 403);

  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  const ended = await api('GET', `/api/listings/${id}`, { cookie: b2 });
  assert.equal(ended.json.listing.status, 'closed');
  assert.equal(ended.json.listing.isWinner, true);
  assert.equal(ended.json.listing.winningBidCents, 1250);
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: b1, body: { amount: 99 } })).status, 409);

  assert.equal((await api('POST', `/api/listings/${id}/checkout`, { cookie: b1 })).status, 403); // loser
  const co = await api('POST', `/api/listings/${id}/checkout`, { cookie: b2 });
  assert.equal(co.status, 200);
  assert.match(co.json.url, /checkout\.stripe\.com/);
  assert.equal(stripeCalls.at(-1).line_items[0].price_data.unit_amount, 1250);

  const v = await api('POST', `/api/listings/${id}/verify-payment`, { cookie: b2 });
  assert.equal(v.json.status, 'paid');
  assert.equal((await api('POST', `/api/listings/${id}/checkout`, { cookie: b2 })).status, 409);
});

test('anti-sniping extends a nearly-finished auction', async () => {
  const seller = (await register('seller3')).cookie;
  const b = (await register('bidder3')).cookie;
  const { json: { id } } = await api('POST', '/api/listings', { cookie: seller, form: listingForm() });
  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() + 30_000, id);
  await api('POST', `/api/listings/${id}/bids`, { cookie: b, body: { amount: 10 } });
  const { json } = await api('GET', `/api/listings/${id}`);
  assert.ok(json.listing.endsAt > Date.now() + 90_000);
});

test('expired listing with no bids; webhook rejects bad signature', async () => {
  const seller = (await register('seller4')).cookie;
  const { json: { id } } = await api('POST', '/api/listings', { cookie: seller, form: listingForm() });
  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1, id);
  assert.equal((await api('GET', `/api/listings/${id}`)).json.listing.status, 'expired');
  // no webhook secret configured in this test app
  assert.equal((await api('POST', '/api/stripe/webhook', { body: {} })).status, 503);
});

test('dashboard and list filters', async () => {
  const u = (await register('dash')).cookie;
  await api('POST', '/api/listings', { cookie: u, form: listingForm({ title: 'Copper wire', category: 'Metal' }) });
  const act = await api('GET', '/api/me/activity', { cookie: u });
  assert.equal(act.json.selling.length, 1);
  const metal = await api('GET', '/api/listings?category=Metal&search=copper');
  assert.ok(metal.json.listings.some((l) => l.title === 'Copper wire'));
  assert.equal((await api('GET', '/api/listings?search=zzzzqq')).json.listings.length, 0);
});
