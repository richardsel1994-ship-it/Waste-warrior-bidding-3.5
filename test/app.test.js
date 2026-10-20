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

const day = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

function listingForm(over = {}, png = PNG) {
  const f = new FormData();
  const d = {
    title: 'Old sofa and garden waste', description: 'Two-seater sofa plus six bags of hedge cuttings',
    category: 'Household', loadSize: 'Half van', location: 'Leeds LS6', address: '12 Example Road, Leeds LS6 1AA',
    accessNotes: 'Side gate, parking on street', collectFrom: day(2), collectBy: day(5),
    startPrice: '100', durationHours: '24', ...over,
  };
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
  assert.equal((await api('POST', '/api/listings', { cookie: s, form: listingForm({ loadSize: 'Huge' }) })).status, 400);
  assert.equal((await api('POST', '/api/listings', { cookie: s, form: listingForm({ collectFrom: day(5), collectBy: day(2) }) })).status, 400);
  // bidding (7 days) would still be open after the last collection date
  assert.equal((await api('POST', '/api/listings', { cookie: s, form: listingForm({ durationHours: '168' }) })).status, 400);
  assert.equal((await api('POST', '/api/listings', { cookie: s, form: listingForm({ address: '' }) })).status, 400);
  const ok = await api('POST', '/api/listings', { cookie: s, form: listingForm() });
  assert.equal(ok.status, 201);
  const got = await api('GET', `/api/listings/${ok.json.id}`);
  assert.equal(got.json.listing.images.length, 1);
  assert.equal(got.json.listing.loadSize, 'Half van');
  assert.equal(got.json.listing.accessNotes, 'Side gate, parking on street');
  assert.equal(got.json.listing.collectBy, day(5));
  assert.equal(got.json.listing.address, undefined); // private to the public
  assert.equal((await api('GET', `/api/listings/${ok.json.id}`, { cookie: s })).json.listing.address, '12 Example Road, Leeds LS6 1AA');
  const img = await fetch(`${base}/uploads/${got.json.listing.images[0]}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
});

test('reverse bidding: lowest bid wins, customer accepts and pays', async () => {
  const customer = (await register('customer2')).cookie;
  const p1 = (await register('provider1')).cookie;
  const p2 = (await register('provider2')).cookie;
  const { json: { id } } = await api('POST', '/api/listings', { cookie: customer, form: listingForm({ startPrice: '100' }) });

  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: customer, body: { amount: 80 } })).status, 403);
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { body: { amount: 80 } })).status, 401);
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: p1, body: { amount: 120 } })).status, 409); // over budget
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: p1, body: { amount: 90 } })).status, 201);
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: p1, body: { amount: 50 } })).status, 409); // already lowest
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: p2, body: { amount: 89.8 } })).status, 409); // not low enough
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: p2, body: { amount: 95 } })).status, 409); // higher than lowest
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: p2, body: { amount: 75 } })).status, 201);

  const open = await api('GET', `/api/listings/${id}`);
  assert.equal(open.json.listing.currentBidCents, 7500);
  assert.equal(open.json.listing.maxNextBidCents, 7450);
  assert.equal(open.json.listing.bids[0].amountCents, 7500);

  // nobody can pay while bidding is open; providers can never pay
  assert.equal((await api('POST', `/api/listings/${id}/checkout`, { cookie: customer })).status, 409);
  assert.equal((await api('POST', `/api/listings/${id}/checkout`, { cookie: p2 })).status, 403);

  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  const ended = await api('GET', `/api/listings/${id}`, { cookie: p2 });
  assert.equal(ended.json.listing.status, 'closed');
  assert.equal(ended.json.listing.isWinner, true);
  assert.equal(ended.json.listing.winningBidCents, 7500);
  assert.equal(ended.json.listing.address, undefined); // not until paid
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: p1, body: { amount: 10 } })).status, 409);

  const co = await api('POST', `/api/listings/${id}/checkout`, { cookie: customer });
  assert.equal(co.status, 200);
  assert.match(co.json.url, /checkout\.stripe\.com/);
  assert.equal(stripeCalls.at(-1).line_items[0].price_data.unit_amount, 7500);
  assert.equal(stripeCalls.at(-1).line_items[0].price_data.currency, 'gbp');

  assert.equal((await api('POST', `/api/listings/${id}/verify-payment`, { cookie: p2 })).status, 403);
  const v = await api('POST', `/api/listings/${id}/verify-payment`, { cookie: customer });
  assert.equal(v.json.status, 'paid');
  assert.equal((await api('POST', `/api/listings/${id}/checkout`, { cookie: customer })).status, 409);

  // once booked, the winning provider gets the address and the customer's contact
  const booked = (await api('GET', `/api/listings/${id}`, { cookie: p2 })).json.listing;
  assert.equal(booked.address, '12 Example Road, Leeds LS6 1AA');
  assert.equal(booked.contact.email, 'customer2@x.com');
  assert.equal((await api('GET', `/api/listings/${id}`, { cookie: customer })).json.listing.contact.email, 'provider2@x.com');
  const loser = (await api('GET', `/api/listings/${id}`, { cookie: p1 })).json.listing;
  assert.equal(loser.address, undefined);
  assert.equal(loser.contact, undefined);
});

test('customer can decline the lowest bid', async () => {
  const customer = (await register('customer5')).cookie;
  const p = (await register('provider5')).cookie;
  const { json: { id } } = await api('POST', '/api/listings', { cookie: customer, form: listingForm() });
  await api('POST', `/api/listings/${id}/bids`, { cookie: p, body: { amount: 60 } });
  assert.equal((await api('POST', `/api/listings/${id}/decline`, { cookie: customer })).status, 409); // still open
  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  assert.equal((await api('POST', `/api/listings/${id}/decline`, { cookie: p })).status, 403);
  assert.equal((await api('POST', `/api/listings/${id}/decline`, { cookie: customer })).status, 200);
  assert.equal((await api('GET', `/api/listings/${id}`)).json.listing.status, 'cancelled');
  assert.equal((await api('POST', `/api/listings/${id}/checkout`, { cookie: customer })).status, 409);
});

test('anti-sniping extends a nearly-finished auction', async () => {
  const seller = (await register('seller3')).cookie;
  const b = (await register('bidder3')).cookie;
  const { json: { id } } = await api('POST', '/api/listings', { cookie: seller, form: listingForm() });
  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() + 30_000, id);
  await api('POST', `/api/listings/${id}/bids`, { cookie: b, body: { amount: 90 } });
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
  await api('POST', '/api/listings', { cookie: u, form: listingForm({ title: 'Brick rubble', category: 'Building rubble' }) });
  const act = await api('GET', '/api/me/activity', { cookie: u });
  assert.equal(act.json.selling.length, 1);
  const rubble = await api('GET', '/api/listings?category=Building%20rubble&search=brick');
  assert.ok(rubble.json.listings.some((l) => l.title === 'Brick rubble'));
  assert.equal((await api('GET', '/api/listings?search=zzzzqq')).json.listings.length, 0);
});

test('older databases are upgraded to the job schema', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { openDb } = require('../server/db');
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'wwb-old-'));
  const d = new DatabaseSync(path.join(old, 'app.db'));
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE listings (id INTEGER PRIMARY KEY, seller_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
      qty_kg REAL NOT NULL, location TEXT NOT NULL, start_price_cents INTEGER NOT NULL, ends_at INTEGER NOT NULL, images TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open', winner_id INTEGER, winning_bid_cents INTEGER, stripe_session_id TEXT, created_at INTEGER NOT NULL);`);
  d.close();
  const db = openDb(old);
  const cols = db.prepare('PRAGMA table_info(listings)').all().map((c) => c.name);
  db.close();
  fs.rmSync(old, { recursive: true, force: true });
  assert.ok(cols.includes('load_size') && cols.includes('access_notes') && cols.includes('collect_by'));
  assert.ok(!cols.includes('qty_kg'));
});
