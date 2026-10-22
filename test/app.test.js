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
const recoveryEmails = [];
const fakeStripe = {
  checkout: {
    sessions: {
      create: async (p) => { stripeCalls.push(p); return { id: 'cs_test_1', url: 'https://checkout.stripe.com/pay/cs_test_1' }; },
      retrieve: async () => ({ id: 'cs_test_1', payment_status: 'paid' }),
    },
  },
  webhooks: { constructEvent: () => { throw new Error('bad'); } },
  // Stripe Connect, for paying haulers
  accounts: {
    create: async (p) => { connectCalls.push(['create', p]); return { id: 'acct_hauler1' }; },
    retrieve: async (id) => ({ id, details_submitted: connectState.ready, payouts_enabled: connectState.ready, capabilities: { transfers: connectState.ready ? 'active' : 'inactive' } }),
    createLoginLink: async () => ({ url: 'https://connect.stripe.com/express/login' }),
  },
  accountLinks: { create: async (p) => { connectCalls.push(['link', p]); return { url: 'https://connect.stripe.com/setup/e/acct_hauler1' }; } },
  transfers: {
    list: async () => ({ data: [] }),
    create: async (p) => { connectCalls.push(['transfer', p]); return { id: `tr_${connectCalls.length}` }; },
  },
};
const connectCalls = [];
const connectState = { ready: false };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwb-'));
  app = createApp({ dataDir: dir, jwtSecret: 'test', stripe: fakeStripe, requireCarrier: false, mailFrom: 'support@example.com', mailer: { sendMail: async (message) => recoveryEmails.push(message) } });
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
    startPrice: '100', durationHours: '3', ...over,
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

test('password recovery sends a one-time reset link and changes the password', async () => {
  await register('recover');
  recoveryEmails.length = 0;
  const unknown = await api('POST', '/api/auth/forgot-password', { body: { email: 'missing@x.com' } });
  assert.equal(unknown.status, 200);
  assert.equal(recoveryEmails.length, 0);

  const requested = await api('POST', '/api/auth/forgot-password', { body: { email: 'recover@x.com' } });
  assert.equal(requested.status, 200);
  assert.match(requested.json.message, /If an account exists/);
  assert.equal(recoveryEmails.length, 1);
  assert.equal(recoveryEmails[0].to, 'recover@x.com');
  const token = recoveryEmails[0].text.match(/#\/reset-password\?token=([a-f\d]{64})/i)[1];

  assert.equal((await api('POST', '/api/auth/reset-password', { body: { token, password: 'newpassword123' } })).status, 200);
  assert.equal((await api('POST', '/api/auth/reset-password', { body: { token, password: 'anotherpassword' } })).status, 400);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'recover@x.com', password: 'password123' } })).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'recover@x.com', password: 'newpassword123' } })).status, 200);
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
  assert.equal((await api('POST', '/api/listings', { cookie: s, form: listingForm({ durationHours: '24' }) })).status, 400);
  assert.equal((await api('POST', '/api/listings', { cookie: s, form: listingForm({ durationHours: '1' }) })).status, 201);
  assert.equal((await api('POST', '/api/listings', { cookie: s, form: listingForm({ durationHours: '23' }) })).status, 201);
  assert.equal((await api('POST', '/api/listings', { cookie: s, form: listingForm({ address: '' }) })).status, 400);
  const ok = await api('POST', '/api/listings', { cookie: s, form: listingForm() });
  assert.equal(ok.status, 201);
  assert.equal((await api('GET', `/api/listings/${ok.json.id}`)).status, 401); // members only
  const viewer = (await register('viewer1')).cookie;
  const got = await api('GET', `/api/listings/${ok.json.id}`, { cookie: viewer });
  assert.equal(got.json.listing.images.length, 1);
  assert.equal(got.json.listing.loadSize, 'Half van');
  assert.equal(got.json.listing.accessNotes, 'Side gate, parking on street');
  assert.equal(got.json.listing.collectBy, day(5));
  assert.equal(got.json.listing.address, undefined); // private to other members
  assert.equal((await api('GET', `/api/listings/${ok.json.id}`, { cookie: s })).json.listing.address, '12 Example Road, Leeds LS6 1AA');
  assert.equal((await fetch(`${base}/uploads/${got.json.listing.images[0]}`)).status, 401);
  const img = await fetch(`${base}/uploads/${got.json.listing.images[0]}`, { headers: { cookie: viewer } });
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

  const open = await api('GET', `/api/listings/${id}`, { cookie: p1 });
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
  // customer pays the bid plus a 10% fee; the provider is owed the bid minus 10%
  const call = stripeCalls.at(-1);
  assert.deepEqual(call.line_items.map((i) => i.price_data.unit_amount), [7500, 750]);
  assert.equal(call.line_items[0].price_data.currency, 'gbp');
  assert.equal(call.metadata.provider_payout_pence, '6750');
  assert.equal(call.metadata.platform_fee_pence, '1500');
  assert.equal(ended.json.listing.providerPayoutCents, 6750);
  assert.equal(ended.json.listing.customerTotalCents, undefined);
  assert.equal((await api('GET', `/api/listings/${id}`, { cookie: customer })).json.listing.customerTotalCents, 8250);

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
  assert.equal((await api('GET', `/api/listings/${id}`, { cookie: customer })).json.listing.status, 'cancelled');
  assert.equal((await api('POST', `/api/listings/${id}/checkout`, { cookie: customer })).status, 409);
});

test('late bids do not extend the auction; it ends at the advertised time', async () => {
  const seller = (await register('seller3')).cookie;
  const b = (await register('bidder3')).cookie;
  const { json: { id } } = await api('POST', '/api/listings', { cookie: seller, form: listingForm() });
  const endsAt = Date.now() + 30_000;
  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(endsAt, id);
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: b, body: { amount: 90 } })).status, 201);
  const { json } = await api('GET', `/api/listings/${id}`, { cookie: b });
  assert.equal(json.listing.endsAt, endsAt);
  // once the time is up, no more bids
  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1, id);
  const late = (await register('bidder3b')).cookie;
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: late, body: { amount: 80 } })).status, 409);
});

test('expired listing with no bids; webhook rejects bad signature', async () => {
  const seller = (await register('seller4')).cookie;
  const { json: { id } } = await api('POST', '/api/listings', { cookie: seller, form: listingForm() });
  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1, id);
  assert.equal((await api('GET', `/api/listings/${id}`, { cookie: seller })).json.listing.status, 'expired');
  // no webhook secret configured in this test app
  assert.equal((await api('POST', '/api/stripe/webhook', { body: {} })).status, 503);
});

test('dashboard and list filters', async () => {
  const u = (await register('dash')).cookie;
  await api('POST', '/api/listings', { cookie: u, form: listingForm({ title: 'Brick rubble', category: 'Building rubble' }) });
  const act = await api('GET', '/api/me/activity', { cookie: u });
  assert.equal(act.json.selling.length, 1);
  assert.equal((await api('GET', '/api/listings')).status, 401);
  assert.equal((await api('GET', '/api/stats')).status, 401);
  const rubble = await api('GET', '/api/listings?category=Building%20rubble&search=brick', { cookie: u });
  assert.ok(rubble.json.listings.some((l) => l.title === 'Brick rubble'));
  assert.equal((await api('GET', '/api/listings?search=zzzzqq', { cookie: u })).json.listings.length, 0);
});

test('older databases are upgraded to the job schema', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { openDb } = require('../server/db');
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'wwb-old-'));
  const d = new DatabaseSync(path.join(old, 'app.db'));
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE listings (id INTEGER PRIMARY KEY, seller_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
      qty_kg REAL NOT NULL, location TEXT NOT NULL, start_price_cents INTEGER NOT NULL, ends_at INTEGER NOT NULL, images TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open', winner_id INTEGER, winning_bid_cents INTEGER, stripe_session_id TEXT, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES (1, 'o@x.com', 'Old', 'x', 1);
    INSERT INTO listings (seller_id, title, description, category, qty_kg, location, start_price_cents, ends_at, status, winner_id, winning_bid_cents, created_at)
      VALUES (1, 'Paid before', 'd', 'Household', 1, 'Hull', 100, 1, 'paid', 1, 90, 5), (1, 'Still open', 'd', 'Household', 1, 'Hull', 100, 1, 'open', NULL, NULL, 6);`);
  d.close();
  const db = openDb(old);
  const cols = db.prepare('PRAGMA table_info(listings)').all().map((c) => c.name);
  // jobs paid before collections needed confirming aren't held
  assert.equal(db.prepare("SELECT completed_at FROM listings WHERE title = 'Paid before'").get().completed_at, 5);
  assert.equal(db.prepare("SELECT completed_at FROM listings WHERE title = 'Still open'").get().completed_at, null);
  db.close();
  // running the upgrade again changes nothing
  const again = openDb(old);
  assert.equal(again.prepare("SELECT completed_at FROM listings WHERE title = 'Still open'").get().completed_at, null);
  again.close();
  fs.rmSync(old, { recursive: true, force: true });
  assert.ok(cols.includes('load_size') && cols.includes('access_notes') && cols.includes('collect_by'));
  assert.ok(!cols.includes('qty_kg'));
});

// ---------- waste carrier checks ----------
const { createCarrierChecker } = require('../server/carrier');
const recordPage = (num, name, expiry) => `<html><body><h1>Registration ${num}</h1>
  <dl><dt>Registration number</dt><dd>${num}</dd><dt>Business name</dt><dd>${name}</dd>
  <dt>Registered as</dt><dd>Carrier, Broker, Dealer - Upper Tier</dd>
  <dt>Registration date</dt><dd>20/09/2024</dd><dt>Expiry date</dt><dd>${expiry}</dd></dl></body></html>`;
const fakeRegister = async (url) => {
  const num = decodeURIComponent(url.split('/').pop());
  if (num === 'CBDU111') return new Response(recordPage(num, 'GOOD HAULAGE LTD', '17/10/2099'), { status: 200 });
  if (num === 'CBDU222') return new Response(recordPage(num, 'OLD HAULAGE LTD', '01/01/2020'), { status: 200 });
  if (num === 'CBDU999') throw new Error('network down');
  return new Response('Not found', { status: 404 });
};

test('carrier checker reads the register record and classifies numbers', async () => {
  const c = createCarrierChecker({ fetchImpl: fakeRegister });
  const ok = await c.check(' cbdu 111 ');
  assert.equal(ok.status, 'registered');
  assert.equal(ok.number, 'CBDU111');
  assert.equal(ok.name, 'GOOD HAULAGE LTD');
  assert.equal(ok.expiresOn, '2099-10-17');
  assert.match(ok.registeredAs, /Upper Tier/);
  assert.equal((await c.check('CBDU222')).status, 'expired');
  assert.equal((await c.check('CBDU333')).status, 'not_found');
  assert.equal((await c.check('CBDU999')).status, 'unavailable');
  assert.equal((await c.check('hello')).status, 'invalid');
  assert.equal((await c.check('WCR/R/1234567')).status, 'other_region');
});

test('haulers: verify a number, show it on bids and the haulers list', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wwb-c-'));
  const a = createApp({ dataDir: d, jwtSecret: 't', demoPayments: true, carrierChecker: createCarrierChecker({ fetchImpl: fakeRegister }) });
  const srv = await new Promise((r) => { const s = a.listen(0, () => r(s)); });
  const b = `http://localhost:${srv.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(b + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  try {
    assert.equal((await call('GET', '/api/carriers/check?number=CBDU111')).status, 401);
    assert.equal((await call('GET', '/api/haulers')).status, 401);
    const cust = await call('POST', '/api/auth/register', { email: 'c@x.com', name: 'Cara Customer', password: 'password123' });
    const pub = await call('GET', '/api/carriers/check?number=CBDU111', null, cust.cookie);
    assert.equal(pub.json.result.status, 'registered');

    const haul = await call('POST', '/api/auth/register', { email: 'h@x.com', name: 'Harry Hauler', password: 'password123' });
    assert.equal((await call('GET', '/api/config')).json.requireCarrier, true); // on by default
    // Only registered carriers can bid
    const early = await fetch(b + '/api/listings', { method: 'POST', headers: { cookie: cust.cookie }, body: listingForm() }).then((r) => r.json());
    const blocked = await call('POST', `/api/listings/${early.id}/bids`, { amount: 90 }, haul.cookie);
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.error, /registered waste carriers/);
    assert.equal((await call('PUT', '/api/me/carrier', { number: 'CBDU333' }, haul.cookie)).status, 400);
    assert.equal((await call('PUT', '/api/me/carrier', { number: 'CBDU222' }, haul.cookie)).status, 400);
    assert.equal((await call('PUT', '/api/me/carrier', { number: 'CBDU999' }, haul.cookie)).status, 503);
    const saved = await call('PUT', '/api/me/carrier', { number: 'cbdu111' }, haul.cookie);
    assert.equal(saved.status, 200);
    assert.equal(saved.json.user.carrier.verified, true);
    assert.equal((await call('GET', '/api/me', null, haul.cookie)).json.user.carrier.number, 'CBDU111');
    assert.equal((await call('PUT', '/api/me/carrier', { number: 'CBDU111' }, cust.cookie)).status, 409);

    const list = await call('GET', '/api/haulers', null, cust.cookie);
    assert.equal(list.json.haulers.length, 1);
    assert.equal(list.json.haulers[0].name, 'Harry Hauler');
    assert.equal(list.json.haulers[0].carrier.name, 'GOOD HAULAGE LTD');
    assert.equal(list.json.haulers[0].carrier.email, undefined);

    const f = listingForm();
    const created = await fetch(b + '/api/listings', { method: 'POST', headers: { cookie: cust.cookie }, body: f }).then((r) => r.json());
    assert.equal((await call('POST', `/api/listings/${created.id}/bids`, { amount: 90 }, haul.cookie)).status, 201);
    const job = await call('GET', `/api/listings/${created.id}`, null, cust.cookie);
    assert.deepEqual(job.json.listing.bids[0].carrier.verified, true);
    assert.equal(job.json.listing.bids[0].carrier.number, 'CBDU111');

    // An expired registration can't bid
    a.db.prepare("UPDATE users SET carrier_expires = '2020-01-01' WHERE email = 'h@x.com'").run();
    const exp = await call('POST', `/api/listings/${early.id}/bids`, { amount: 80 }, haul.cookie);
    assert.equal(exp.status, 403);
    assert.match(exp.json.error, /expired/);

    assert.equal((await call('PUT', '/api/me/carrier', { number: '' }, haul.cookie)).json.user.carrier, null);
    assert.equal((await call('GET', '/api/haulers', null, cust.cookie)).json.haulers.length, 0);
  } finally {
    srv.close(); a.close(); fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---------- Waste Warrior Plus ----------
test('plus: subscribers pay the lower customer fee; providers still pay the standard fee', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wwb-p-'));
  const calls = [];
  const subs = {};
  const stripe = {
    checkout: {
      sessions: {
        create: async (p) => { calls.push(p); return { id: `cs_${calls.length}`, url: `https://checkout.stripe.com/pay/cs_${calls.length}` }; },
        retrieve: async (id) => (id === 'cs_1'
          ? { id, status: 'complete', subscription: 'sub_1' }
          : { id, payment_status: 'paid' }),
      },
    },
    subscriptions: {
      retrieve: async (id) => subs[id],
      update: async (id, p) => Object.assign(subs[id], { cancel_at_period_end: p.cancel_at_period_end }),
    },
    webhooks: { constructEvent: () => { throw new Error('bad'); } },
  };
  const a = createApp({ dataDir: d, jwtSecret: 't', stripe, plusPriceId: 'price_plus', requireCarrier: false });
  const srv = await new Promise((r) => { const s = a.listen(0, () => r(s)); });
  const b = `http://localhost:${srv.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(b + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  try {
    const cfg = await call('GET', '/api/config');
    assert.deepEqual(cfg.json.plus, { available: true, feePercent: 6, pricePence: 295 });

    const cust = await call('POST', '/api/auth/register', { email: 'p@x.com', name: 'Pat Plus', password: 'password123' });
    const haul = await call('POST', '/api/auth/register', { email: 'q@x.com', name: 'Quinn Hauler', password: 'password123' });
    assert.equal(cust.json.user.plus.active, false);

    const co = await call('POST', '/api/plus/checkout', null, cust.cookie);
    assert.equal(co.status, 200);
    assert.equal(calls[0].mode, 'subscription');
    assert.deepEqual(calls[0].line_items, [{ price: 'price_plus', quantity: 1 }]);
    const uid = cust.json.user.id;
    assert.equal(calls[0].metadata.user_id, String(uid));

    subs.sub_1 = { id: 'sub_1', status: 'active', customer: 'cus_1', cancel_at_period_end: false, metadata: { user_id: String(uid) },
      items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] } };
    const v = await call('POST', '/api/plus/verify', null, cust.cookie);
    assert.equal(v.json.user.plus.active, true);
    assert.equal((await call('POST', '/api/plus/checkout', null, cust.cookie)).status, 409);

    // A job paid for by a Plus member: 6% added for the customer, 10% taken from the provider.
    const created = await fetch(b + '/api/listings', { method: 'POST', headers: { cookie: cust.cookie }, body: listingForm() }).then((r) => r.json());
    await call('POST', `/api/listings/${created.id}/bids`, { amount: 100 }, haul.cookie);
    a.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, created.id);
    const job = await call('GET', `/api/listings/${created.id}`, null, cust.cookie);
    assert.equal(job.json.listing.customerFeePercent, 6);
    assert.equal(job.json.listing.customerTotalCents, 10600);
    const pay = await call('POST', `/api/listings/${created.id}/checkout`, null, cust.cookie);
    assert.equal(pay.status, 200);
    const jobCall = calls[calls.length - 1];
    assert.equal(jobCall.line_items[1].price_data.unit_amount, 600);
    assert.match(jobCall.line_items[1].price_data.product_data.name, /6%/);
    assert.equal(jobCall.metadata.provider_payout_pence, '9000');
    assert.equal(jobCall.metadata.platform_fee_pence, '1600');
    const won = await call('GET', `/api/listings/${created.id}`, null, haul.cookie);
    assert.equal(won.json.listing.providerPayoutCents, 9000);

    // Cancelling keeps Plus until the end of the month; resuming undoes it.
    const c1 = await call('POST', '/api/plus/cancel', null, cust.cookie);
    assert.equal(c1.json.user.plus.active, true);
    assert.equal(c1.json.user.plus.cancelAtEnd, true);
    assert.equal((await call('POST', '/api/plus/resume', null, cust.cookie)).json.user.plus.cancelAtEnd, false);

    // Once Stripe ends the subscription the standard fee applies again.
    subs.sub_1.status = 'canceled';
    a.db.prepare("UPDATE users SET plus_status = 'canceled' WHERE id = ?").run(uid);
    assert.equal((await call('GET', '/api/me', null, cust.cookie)).json.user.plus.active, false);
  } finally {
    srv.close(); a.close(); fs.rmSync(d, { recursive: true, force: true });
  }
});

test('hauler pro: subscribed haulers have a lower fee taken from their winning bid', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wwb-pro-'));
  const a = createApp({ dataDir: d, jwtSecret: 't', demoPayments: true, stripeKey: '', requireCarrier: false });
  const srv = await new Promise((r) => { const s = a.listen(0, () => r(s)); });
  const b = `http://localhost:${srv.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(b + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  const reg = async (e, n) => {
    const res = await fetch(b + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, name: n, password: 'password123' }) });
    return (res.headers.get('set-cookie') || '').split(';')[0];
  };
  try {
    assert.deepEqual((await call('GET', '/api/config')).json.pro, { available: true, feePercent: 6, pricePence: 499 });
    const cust = await reg('c2@x.com', 'Cam Customer');
    const haul = await reg('h2@x.com', 'Hal Hauler');
    const sub = await call('POST', '/api/pro/checkout', null, haul);
    assert.equal(sub.json.user.pro.active, true);
    assert.equal(sub.json.user.plus.active, false);

    const created = await fetch(b + '/api/listings', { method: 'POST', headers: { cookie: cust }, body: listingForm() }).then((r) => r.json());
    await call('POST', `/api/listings/${created.id}/bids`, { amount: 100 }, haul);
    a.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, created.id);
    // customer has no plan: 10% on top; hauler is Pro: only 6% taken
    const forCustomer = await call('GET', `/api/listings/${created.id}`, null, cust);
    assert.equal(forCustomer.json.listing.customerTotalCents, 11000);
    assert.equal((await call('POST', `/api/listings/${created.id}/checkout`, null, cust)).status, 200);
    const forHauler = await call('GET', `/api/listings/${created.id}`, null, haul);
    assert.equal(forHauler.json.listing.providerFeePercent, 6);
    assert.equal(forHauler.json.listing.providerPayoutCents, 9400);

    // the fee was fixed at payment, so cancelling later doesn't change it
    await call('POST', '/api/pro/cancel', null, haul);
    a.db.prepare("UPDATE users SET pro_status = 'canceled'").run();
    assert.equal((await call('GET', `/api/listings/${created.id}`, null, haul)).json.listing.providerPayoutCents, 9400);
  } finally {
    srv.close(); a.close(); fs.rmSync(d, { recursive: true, force: true });
  }
});

test('admin: only admin accounts can see everything and remove jobs', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wwb-adm-'));
  const a = createApp({ dataDir: d, jwtSecret: 't', demoPayments: true, stripeKey: '', adminEmails: 'Boss@X.com' });
  const srv = await new Promise((r) => { const s = a.listen(0, () => r(s)); });
  const b = `http://localhost:${srv.address().port}`;
  const call = async (method, url, cookie) => {
    const res = await fetch(b + url, { method, headers: cookie ? { cookie } : {} });
    return { status: res.status, json: await res.json() };
  };
  const reg = async (e, n) => {
    const res = await fetch(b + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, name: n, password: 'password123' }) });
    return { cookie: (res.headers.get('set-cookie') || '').split(';')[0], user: (await res.json()).user };
  };
  try {
    const boss = await reg('boss@x.com', 'The Boss');
    const cust = await reg('cust@x.com', 'A Customer');
    assert.equal(boss.user.admin, true);
    assert.equal(cust.user.admin, undefined);
    assert.equal((await call('GET', '/api/admin/overview', cust.cookie)).status, 403);
    assert.equal((await call('GET', '/api/admin/overview')).status, 401);

    const created = await fetch(b + '/api/listings', { method: 'POST', headers: { cookie: cust.cookie }, body: listingForm() }).then((r) => r.json());
    const o = await call('GET', '/api/admin/overview', boss.cookie);
    assert.equal(o.status, 200);
    assert.equal(o.json.users, 2);
    assert.equal(o.json.jobs.open, 1);
    const jobs = await call('GET', '/api/admin/jobs', boss.cookie);
    assert.equal(jobs.json.jobs[0].customer.email, 'cust@x.com');
    assert.equal((await call('GET', '/api/admin/users', boss.cookie)).json.users.length, 2);

    assert.equal((await call('POST', `/api/admin/jobs/${created.id}/remove`, cust.cookie)).status, 403);
    assert.equal((await call('POST', `/api/admin/jobs/${created.id}/remove`, boss.cookie)).status, 200);
    assert.equal((await call('GET', '/api/listings', cust.cookie)).json.listings.length, 0);
    assert.equal((await call('GET', `/api/listings/${created.id}`)).status, 401);
    assert.equal((await call('GET', `/api/listings/${created.id}`, cust.cookie)).json.listing.status, 'removed');
  } finally {
    srv.close(); a.close(); fs.rmSync(d, { recursive: true, force: true });
  }
});

test('payouts: haulers add their bank through Stripe and get paid when customers pay', async () => {
  const customer = (await register('payc')).cookie;
  const hauler = (await register('payh')).cookie;
  assert.equal((await api('GET', '/api/me/payouts')).status, 401);

  const before = await api('GET', '/api/me/payouts', { cookie: hauler });
  assert.equal(before.json.available, true);
  assert.equal(before.json.connected, false);
  assert.equal((await api('POST', '/api/me/payouts/dashboard', { cookie: hauler })).status, 409);

  // win and get paid for a job before payouts are set up: the money waits
  const { json: { id } } = await api('POST', '/api/listings', { cookie: customer, form: listingForm({ startPrice: '100' }) });
  assert.equal((await api('POST', `/api/listings/${id}/bids`, { cookie: hauler, body: { amount: 80 } })).status, 201);
  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  await api('GET', `/api/listings/${id}`, { cookie: hauler });
  assert.equal((await api('POST', `/api/listings/${id}/checkout`, { cookie: customer })).status, 200);
  assert.equal((await api('POST', `/api/listings/${id}/verify-payment`, { cookie: customer })).json.status, 'paid');
  await app.payoutsSettled();
  // held until the collection is confirmed
  assert.equal((await api('GET', `/api/listings/${id}`, { cookie: hauler })).json.listing.payoutStatus, 'held');
  assert.equal((await api('POST', `/api/listings/${id}/confirm`, { cookie: hauler })).status, 403);
  assert.equal((await api('POST', `/api/listings/${id}/collected`, { cookie: customer })).status, 403);
  const conf = await api('POST', `/api/listings/${id}/confirm`, { cookie: customer, body: { rating: 5, comment: 'Quick and tidy' } });
  assert.equal(conf.status, 200);
  assert.ok(conf.json.listing.completedAt);
  assert.deepEqual(conf.json.listing.review, { rating: 5, comment: 'Quick and tidy' });
  await app.payoutsSettled();
  assert.equal((await api('GET', `/api/listings/${id}`, { cookie: hauler })).json.listing.payoutStatus, 'pending');
  assert.equal(connectCalls.filter((c) => c[0] === 'transfer').length, 0);
  const waiting = (await api('GET', '/api/me/payouts', { cookie: hauler })).json;
  assert.equal(waiting.waitingCents, 7200);
  assert.equal(waiting.jobs[0].status, 'pending');

  // set up payouts: a UK Express account and a link to Stripe's onboarding
  const setup = await api('POST', '/api/me/payouts/setup', { cookie: hauler });
  assert.match(setup.json.url, /connect\.stripe\.com/);
  const created = connectCalls.find((c) => c[0] === 'create')[1];
  assert.equal(created.type, 'express');
  assert.equal(created.country, 'GB');
  assert.equal(created.email, 'payh@x.com');
  assert.match(connectCalls.find((c) => c[0] === 'link')[1].return_url, /#\/payouts\?done=1$/);
  await api('POST', '/api/me/payouts/setup', { cookie: hauler });
  assert.equal(connectCalls.filter((c) => c[0] === 'create').length, 1); // reuses the account

  // once Stripe has verified them, the waiting money is sent
  connectState.ready = true;
  const after = (await api('GET', '/api/me/payouts', { cookie: hauler })).json;
  assert.equal(after.enabled, true);
  const transfers = connectCalls.filter((c) => c[0] === 'transfer');
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0][1].amount, 7200); // £80 bid minus the 10% fee
  assert.equal(transfers[0][1].destination, 'acct_hauler1');
  assert.equal(after.jobs[0].status, 'sent');
  assert.equal(after.sentCents, 7200);
  assert.equal(after.waitingCents, 0);
  assert.equal((await api('GET', '/api/me', { cookie: hauler })).json.user.payouts.enabled, true);
  assert.match((await api('POST', '/api/me/payouts/dashboard', { cookie: hauler })).json.url, /connect\.stripe\.com/);

  // the next paid job is sent straight away, and only once
  const { json: { id: id2 } } = await api('POST', '/api/listings', { cookie: customer, form: listingForm({ startPrice: '100' }) });
  await api('POST', `/api/listings/${id2}/bids`, { cookie: hauler, body: { amount: 50 } });
  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, id2);
  await api('GET', `/api/listings/${id2}`, { cookie: hauler });
  await api('POST', `/api/listings/${id2}/checkout`, { cookie: customer });
  await api('POST', `/api/listings/${id2}/verify-payment`, { cookie: customer });
  await api('POST', `/api/listings/${id2}/verify-payment`, { cookie: customer });
  await app.payoutsSettled();
  assert.equal(connectCalls.filter((c) => c[0] === 'transfer').length, 1); // held
  // the hauler marks it collected; the customer doesn't respond, so it's released automatically
  const col = await api('POST', `/api/listings/${id2}/collected`, { cookie: hauler });
  assert.equal(col.status, 200);
  assert.ok(col.json.listing.releaseAt > Date.now() + 23 * 3600_000);
  app.releaseDue();
  await app.payoutsSettled();
  assert.equal(connectCalls.filter((c) => c[0] === 'transfer').length, 1); // not yet due
  app.db.prepare('UPDATE listings SET release_at = ? WHERE id = ?').run(Date.now() - 1, id2);
  app.releaseDue();
  app.releaseDue();
  await app.payoutsSettled();
  assert.equal(connectCalls.filter((c) => c[0] === 'transfer').length, 2); // sent once
  const done = (await api('GET', `/api/listings/${id2}`, { cookie: customer })).json.listing;
  assert.equal(done.autoReleased, true);
  assert.equal((await api('GET', `/api/listings/${id2}`, { cookie: hauler })).json.listing.payoutStatus, 'sent');
  // reviews: once per job, 1 to 5 stars; shown as the hauler's rating
  assert.equal((await api('POST', `/api/listings/${id2}/review`, { cookie: customer, body: { rating: 6 } })).status, 400);
  assert.equal((await api('POST', `/api/listings/${id2}/review`, { cookie: hauler, body: { rating: 4 } })).status, 403);
  assert.equal((await api('POST', `/api/listings/${id2}/review`, { cookie: customer, body: { rating: 4 } })).status, 201);
  assert.equal((await api('POST', `/api/listings/${id2}/review`, { cookie: customer, body: { rating: 4 } })).status, 409);
  assert.deepEqual((await api('GET', `/api/listings/${id2}`, { cookie: customer })).json.listing.winnerRating, { average: 4.5, count: 2 });
  // a problem report holds the payout
  const { json: { id: id3 } } = await api('POST', '/api/listings', { cookie: customer, form: listingForm({ startPrice: '100' }) });
  await api('POST', `/api/listings/${id3}/bids`, { cookie: hauler, body: { amount: 40 } });
  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, id3);
  await api('GET', `/api/listings/${id3}`, { cookie: hauler });
  await api('POST', `/api/listings/${id3}/checkout`, { cookie: customer });
  await api('POST', `/api/listings/${id3}/verify-payment`, { cookie: customer });
  await api('POST', `/api/listings/${id3}/collected`, { cookie: hauler });
  assert.equal((await api('POST', `/api/listings/${id3}/problem`, { cookie: customer, body: { note: 'no' } })).status, 400);
  assert.equal((await api('POST', `/api/listings/${id3}/problem`, { cookie: customer, body: { note: 'They left half the bags behind' } })).status, 200);
  app.db.prepare('UPDATE listings SET release_at = ? WHERE id = ?').run(Date.now() - 1, id3);
  app.releaseDue();
  await app.payoutsSettled();
  assert.equal(connectCalls.filter((c) => c[0] === 'transfer').length, 2);
  assert.equal((await api('GET', `/api/listings/${id3}`, { cookie: hauler })).json.listing.payoutStatus, 'held');
  // confirming afterwards (problem sorted) pays straight away
  await api('POST', `/api/listings/${id3}/confirm`, { cookie: customer });
  await app.payoutsSettled();
  assert.equal(connectCalls.filter((c) => c[0] === 'transfer').length, 3);
  assert.equal((await api('POST', `/api/listings/${id3}/problem`, { cookie: customer, body: { note: 'Too late now' } })).status, 409);
});

test('customer can choose any hauler’s bid, not only the lowest', async () => {
  const customer = (await register('choosec')).cookie;
  const cheap = (await register('cheaph')).cookie;
  const good = (await register('goodh')).cookie;
  const { json: { id } } = await api('POST', '/api/listings', { cookie: customer, form: listingForm({ startPrice: '100' }) });
  await api('POST', `/api/listings/${id}/bids`, { cookie: good, body: { amount: 90 } });
  await api('POST', `/api/listings/${id}/bids`, { cookie: cheap, body: { amount: 80 } });
  await api('POST', `/api/listings/${id}/bids`, { cookie: good, body: { amount: 70 } });
  await api('POST', `/api/listings/${id}/bids`, { cookie: cheap, body: { amount: 60 } });
  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  const closed = (await api('GET', `/api/listings/${id}`, { cookie: customer })).json.listing;
  // one choice per hauler, at their best price, lowest first
  assert.deepEqual(closed.choices.map((c) => [c.bidder, c.amountCents, c.lowest]), [['cheaph user', 6000, true], ['goodh user', 7000, false]]);
  assert.equal((await api('GET', `/api/listings/${id}`, { cookie: good })).json.listing.choices, undefined);
  // a hauler's older, higher bid can't be chosen
  const older = app.db.prepare('SELECT id FROM bids WHERE listing_id = ? AND amount_cents = 9000').get(id).id;
  assert.equal((await api('POST', `/api/listings/${id}/checkout`, { cookie: customer, body: { bidId: older } })).status, 400);
  const pick = closed.choices[1].bidId;
  const co = await api('POST', `/api/listings/${id}/checkout`, { cookie: customer, body: { bidId: pick } });
  assert.equal(co.status, 200);
  assert.equal(stripeCalls.at(-1).line_items[0].price_data.unit_amount, 7000);
  assert.equal(stripeCalls.at(-1).metadata.provider_payout_pence, '6300');
  assert.equal((await api('GET', `/api/listings/${id}`, { cookie: good })).json.listing.isWinner, true);
  assert.equal((await api('GET', `/api/listings/${id}`, { cookie: cheap })).json.listing.isWinner, false);
  await api('POST', `/api/listings/${id}/verify-payment`, { cookie: customer });
  assert.equal((await api('GET', `/api/listings/${id}`, { cookie: good })).json.listing.contact.email, 'choosec@x.com');
  assert.equal((await api('GET', `/api/listings/${id}`, { cookie: cheap })).json.listing.contact, undefined);
});

test('choices show each hauler’s recent written reviews and flag the top rated', async () => {
  // Accounts are made directly and signed in with a token: the tests already use most of the sign-up rate limit.
  const ids = {}, cookieFor = {};
  for (const n of ['revc', 'revcheap', 'revgood']) {
    ids[n] = Number(app.db.prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, 'x', ?)").run(`${n}@x.com`, `${n} user`, Date.now()).lastInsertRowid);
    cookieFor[n] = `token=${require('jsonwebtoken').sign({ sub: ids[n] }, 'test', { expiresIn: '1h' })}`;
  }
  const customer = cookieFor.revc, cheap = cookieFor.revcheap, good = cookieFor.revgood;
  // past jobs for the reviews to hang off
  const pastJob = () => Number(app.db.prepare("INSERT INTO listings (seller_id, title, description, category, location, start_price_cents, ends_at, status, created_at) VALUES (?, 'old', 'old', 'Household', 'Hull', 1000, 0, 'paid', 0)").run(ids.revc).lastInsertRowid);
  const review = (hauler, rating, comment, at) => app.db.prepare('INSERT INTO reviews (listing_id, hauler_id, customer_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(pastJob(), hauler, ids.revc, rating, comment, at);
  review(ids.revgood, 5, 'Quick and tidy', 3);
  review(ids.revgood, 5, '', 2);
  review(ids.revcheap, 2, 'Left bits behind', 1);
  const { json: { id } } = await api('POST', '/api/listings', { cookie: customer, form: listingForm({ startPrice: '100' }) });
  await api('POST', `/api/listings/${id}/bids`, { cookie: good, body: { amount: 80 } });
  await api('POST', `/api/listings/${id}/bids`, { cookie: cheap, body: { amount: 70 } });
  app.db.prepare('UPDATE listings SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  const { choices } = (await api('GET', `/api/listings/${id}`, { cookie: customer })).json.listing;
  assert.deepEqual(choices.map((c) => [c.bidder, c.lowest, c.topRated]), [['revcheap user', true, false], ['revgood user', false, true]]);
  // only reviews with words in them, newest first, signed with a first name
  assert.deepEqual(choices[1].reviews.map((r) => [r.rating, r.comment, r.by]), [[5, 'Quick and tidy', 'revc']]);
  assert.equal(choices[1].rating.count, 2);
});

test('public pages: front page shell, local pages, haulers, terms, privacy, sitemap', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.ok(html.includes(`<link rel="canonical" href="${base}/">`), 'share links use the site address');
  assert.ok(!html.includes('__BASE_URL__'));
  for (const p of ['/rubbish-removal/hull', '/rubbish-removal/beverley', '/services/sofa-removal', '/for-haulers', '/terms', '/privacy']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /<h1>/, p);
  }
  assert.equal((await fetch(`${base}/rubbish-removal/atlantis`)).status, 404);
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /Disallow: \/api\//);
  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.ok(sitemap.includes(`${base}/rubbish-removal/hull`));
  assert.equal((await fetch(`${base}/og.png`)).status, 200);
});

test('public overview previews open jobs without private details', async () => {
  const u = (await register('teaser')).cookie;
  const created = await api('POST', '/api/listings', { cookie: u, form: listingForm({ title: 'Secret title', description: 'Secret description text', location: 'Hull HU5', address: '1 Hidden Street, Hull HU5 1AA' }) });
  assert.equal(created.status, 201);
  const o = await api('GET', '/api/public/overview');
  assert.equal(o.status, 200);
  const job = o.json.jobs.find((j) => j.area === 'Hull HU5');
  assert.ok(job, 'open job is previewed');
  assert.deepEqual(Object.keys(job).sort(), ['area', 'bidCount', 'category', 'currentBidCents', 'endsAt', 'loadSize']);
  const raw = JSON.stringify(o.json);
  for (const secret of ['Secret title', 'Secret description', 'Hidden Street', '.png', 'teaser@x.com']) assert.ok(!raw.includes(secret), secret);
  assert.ok(o.json.towns.some((t) => t.slug === 'hull'));
  // The full job is still members-only.
  assert.equal((await api('GET', `/api/listings/${created.json.id}`)).status, 401);
  // The Hull page counts it as live.
  assert.match(await (await fetch(`${base}/rubbish-removal/hull`)).text(), /job[s]? near Hull taking bids/);
});

test('price guide: researched regular prices replace the old estimates and suggest a starting price', async () => {
  const prices = require('../server/prices');
  // one chair on its own uses the full chair price
  assert.deepEqual(prices.estimate({ chair: 1 }), { low: 30, high: 50 });
  // a second item in the same trip costs less; bags add up in full
  assert.deepEqual(prices.estimate({ chair: 2, bag: 4 }), { low: 75, high: 130 });
  assert.equal(prices.estimate({}), null);
  assert.equal(prices.estimate({ nonsense: 3 }), null);
  const cfg = (await api('GET', '/api/config')).json;
  assert.ok(cfg.priceGuide.groups.some((g) => g.items.some((i) => i.id === 'shed-medium')));
  for (const id of cfg.priceGuide.headline) assert.ok(prices.rangeText(id));
  for (const ids of Object.values(prices.FOR_SERVICE)) for (const id of ids) assert.ok(prices.rangeText(id));
  const service = await (await fetch(`${base}/services/house-clearance`)).text();
  assert.match(service, /Regular prices for the same job with other UK waste companies/);
  assert.match(service, /£600–£1,200/);
  const hull = await (await fetch(`${base}/rubbish-removal/hull`)).text();
  assert.match(hull, /Regular price with other waste companies/);
  assert.doesNotMatch(hull, /£1\.50–£3\.00/);
});

test('jobs priced with the guide cannot start above the lowest regular price', async () => {
  const uid = app.db.prepare('SELECT id FROM users WHERE email = ?').get('choosec@x.com').id;
  const customer = `token=${require('jsonwebtoken').sign({ sub: uid }, 'test', { expiresIn: '1h' })}`;
  const items = JSON.stringify({ fridge: 1 }); // regular price £40–£115
  const tooHigh = await api('POST', '/api/listings', { cookie: customer, form: listingForm({ startPrice: '41', guideItems: items }) });
  assert.equal(tooHigh.status, 400);
  assert.match(tooHigh.json.error, /£40/);
  assert.equal((await api('POST', '/api/listings', { cookie: customer, form: listingForm({ startPrice: '40', guideItems: items }) })).status, 201);
  assert.equal((await api('POST', '/api/listings', { cookie: customer, form: listingForm({ startPrice: '25', guideItems: items }) })).status, 201);
  // without the guide the customer sets their own price as before
  assert.equal((await api('POST', '/api/listings', { cookie: customer, form: listingForm({ startPrice: '90' }) })).status, 201);
});
