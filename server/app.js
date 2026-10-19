const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { openDb, tx } = require('./db');

const CATEGORIES = ['Plastic', 'Metal', 'Paper', 'Glass', 'E-waste', 'Organic', 'Textile', 'Wood'];
const MIN_INCREMENT_CENTS = 50;
const MAX_IMAGES = 4;
const IMAGE_TYPES = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', test: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createApp(opts = {}) {
  const config = {
    dataDir: opts.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
    baseUrl: (opts.baseUrl || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
    jwtSecret: opts.jwtSecret || process.env.JWT_SECRET,
    stripeKey: opts.stripeKey !== undefined ? opts.stripeKey : process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: opts.stripeWebhookSecret || process.env.STRIPE_WEBHOOK_SECRET,
    demoPayments: opts.demoPayments !== undefined ? opts.demoPayments : process.env.DEMO_PAYMENTS === '1',
    production: process.env.NODE_ENV === 'production',
    stripe: opts.stripe,
  };
  if (!config.jwtSecret) {
    if (config.production) throw new Error('JWT_SECRET must be set in production');
    config.jwtSecret = crypto.randomBytes(32).toString('hex');
    console.warn('JWT_SECRET not set; using a random one (logins reset on restart).');
  }
  if (!config.stripe && config.stripeKey) config.stripe = require('stripe')(config.stripeKey);

  const db = openDb(config.dataDir);
  const uploadDir = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'", 'https://checkout.stripe.com'],
        frameAncestors: ["'none'"],
      },
    },
  }));

  // ---------- helpers ----------
  const now = () => Date.now();
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  function settle(listing) {
    if (!listing || listing.status !== 'open' || listing.ends_at > now()) return listing;
    tx(db, () => {
      const l = one('SELECT * FROM listings WHERE id = ?', listing.id);
      if (l.status !== 'open') return;
      const top = one('SELECT user_id, amount_cents FROM bids WHERE listing_id = ? ORDER BY amount_cents DESC, id ASC LIMIT 1', l.id);
      if (top) run("UPDATE listings SET status = 'closed', winner_id = ?, winning_bid_cents = ? WHERE id = ?", top.user_id, top.amount_cents, l.id);
      else run("UPDATE listings SET status = 'expired' WHERE id = ?", l.id);
    });
    return one('SELECT * FROM listings WHERE id = ?', listing.id);
  }
  function settleAllDue() {
    for (const l of q("SELECT * FROM listings WHERE status = 'open' AND ends_at <= ?", now())) settle(l);
  }
  const timer = setInterval(settleAllDue, 15000);
  timer.unref();

  function publicListing(l, userId) {
    const top = one('SELECT MAX(amount_cents) AS m, COUNT(*) AS n FROM bids WHERE listing_id = ?', l.id);
    const seller = one('SELECT name FROM users WHERE id = ?', l.seller_id);
    const current = top.m || l.start_price_cents;
    return {
      id: l.id, title: l.title, description: l.description, category: l.category,
      qtyKg: l.qty_kg, location: l.location, images: JSON.parse(l.images),
      startPriceCents: l.start_price_cents, currentBidCents: current, bidCount: top.n,
      minNextBidCents: top.n ? current + MIN_INCREMENT_CENTS : l.start_price_cents,
      endsAt: l.ends_at, status: l.status, sellerName: seller.name,
      isSeller: userId === l.seller_id,
      isWinner: l.winner_id != null && userId === l.winner_id,
      winnerName: l.winner_id ? one('SELECT name FROM users WHERE id = ?', l.winner_id).name : null,
      winningBidCents: l.winning_bid_cents,
      createdAt: l.created_at,
    };
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  function auth(required) {
    return (req, res, next) => {
      const token = req.cookies && req.cookies.token;
      req.user = null;
      if (token) {
        try {
          const { sub } = jwt.verify(token, config.jwtSecret);
          req.user = one('SELECT id, email, name FROM users WHERE id = ?', sub) || null;
        } catch { /* invalid token: treat as logged out */ }
      }
      if (required && !req.user) return next(new HttpError(401, 'Please log in first'));
      next();
    };
  }

  function setSession(res, userId) {
    const token = jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: '7d' });
    res.cookie('token', token, {
      httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: 7 * 24 * 3600 * 1000,
    });
  }

  // ---------- Stripe webhook (needs raw body, so before express.json) ----------
  function markPaid(listingId, sessionId) {
    run("UPDATE listings SET status = 'paid' WHERE id = ? AND status = 'closed' AND stripe_session_id = ?", listingId, sessionId);
  }
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    if (!config.stripe || !config.stripeWebhookSecret) return res.status(503).end();
    let event;
    try {
      event = config.stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripeWebhookSecret);
    } catch {
      return res.status(400).send('Bad signature');
    }
    if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
      const s = event.data.object;
      markPaid(Number(s.metadata && s.metadata.listing_id), s.id);
    }
    res.json({ received: true });
  });

  app.use(express.json({ limit: '20kb' }));
  app.use(cookieParser());
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

  // ---------- auth ----------
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
    const { email = '', name = '', password = '' } = req.body || {};
    const e = String(email).trim().toLowerCase();
    const n = String(name).trim();
    if (!emailRe.test(e) || e.length > 200) throw new HttpError(400, 'Enter a valid email');
    if (n.length < 2 || n.length > 60) throw new HttpError(400, 'Name must be 2-60 characters');
    if (typeof password !== 'string' || password.length < 8 || password.length > 100) throw new HttpError(400, 'Password must be 8-100 characters');
    if (one('SELECT 1 FROM users WHERE email = ?', e)) throw new HttpError(409, 'That email is already registered');
    const hash = await bcrypt.hash(password, 10);
    const r = run('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)', e, n, hash, now());
    setSession(res, Number(r.lastInsertRowid));
    res.status(201).json({ user: { id: Number(r.lastInsertRowid), email: e, name: n } });
  }));

  app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
    const { email = '', password = '' } = req.body || {};
    const u = one('SELECT * FROM users WHERE email = ?', String(email).trim().toLowerCase());
    const ok = u && typeof password === 'string' && await bcrypt.compare(password, u.password_hash);
    if (!ok) throw new HttpError(401, 'Wrong email or password');
    setSession(res, u.id);
    res.json({ user: { id: u.id, email: u.email, name: u.name } });
  }));

  app.post('/api/auth/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
  app.get('/api/me', auth(false), (req, res) => res.json({ user: req.user }));

  // ---------- config for the client ----------
  app.get('/api/config', (req, res) => res.json({
    categories: CATEGORIES,
    maxImages: MAX_IMAGES,
    paymentMode: config.stripe ? 'stripe' : config.demoPayments ? 'demo' : 'off',
  }));

  // ---------- listings ----------
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: MAX_IMAGES, fields: 10 },
  });

  app.post('/api/listings', auth(true), upload.array('images', MAX_IMAGES), wrap(async (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    const description = String(b.description || '').trim();
    const location = String(b.location || '').trim();
    const qty = Number(b.qtyKg);
    const startCents = Math.round(Number(b.startPrice) * 100);
    const hours = Number(b.durationHours);
    if (title.length < 3 || title.length > 80) throw new HttpError(400, 'Title must be 3-80 characters');
    if (description.length < 10 || description.length > 2000) throw new HttpError(400, 'Description must be 10-2000 characters');
    if (!CATEGORIES.includes(b.category)) throw new HttpError(400, 'Choose a valid category');
    if (location.length < 2 || location.length > 100) throw new HttpError(400, 'Enter a pickup location');
    if (!(qty > 0 && qty <= 1_000_000)) throw new HttpError(400, 'Enter a valid quantity in kg');
    if (!Number.isInteger(startCents) || startCents < 100 || startCents > 100_000_00) throw new HttpError(400, 'Starting price must be between $1 and $100,000');
    if (![24, 72, 168, 336].includes(hours)) throw new HttpError(400, 'Choose a valid auction length');
    const files = req.files || [];
    if (!files.length) throw new HttpError(400, 'Add at least one photo');
    const names = [];
    for (const f of files) {
      const type = IMAGE_TYPES.find((t) => t.test(f.buffer));
      if (!type) throw new HttpError(400, 'Photos must be JPEG, PNG or WebP images');
      names.push(`${crypto.randomUUID()}.${type.ext}`);
    }
    files.forEach((f, i) => fs.writeFileSync(path.join(uploadDir, names[i]), f.buffer));
    const r = run(
      `INSERT INTO listings (seller_id, title, description, category, qty_kg, location, start_price_cents, ends_at, images, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      req.user.id, title, description, b.category, qty, location, startCents, now() + hours * 3600_000, JSON.stringify(names), now());
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  }));

  app.get('/api/listings', auth(false), (req, res) => {
    settleAllDue();
    const { category, search, sort = 'ending' } = req.query;
    const rows = q("SELECT * FROM listings WHERE status = 'open'");
    let list = rows.map((l) => publicListing(l, req.user && req.user.id));
    if (category && category !== 'all') list = list.filter((l) => l.category === category);
    if (search) {
      const s = String(search).toLowerCase().slice(0, 80);
      list = list.filter((l) => (l.title + ' ' + l.description + ' ' + l.location).toLowerCase().includes(s));
    }
    const sorters = {
      ending: (a, b) => a.endsAt - b.endsAt,
      newest: (a, b) => b.createdAt - a.createdAt,
      priceLow: (a, b) => a.currentBidCents - b.currentBidCents,
      priceHigh: (a, b) => b.currentBidCents - a.currentBidCents,
      popular: (a, b) => b.bidCount - a.bidCount,
    };
    list.sort(sorters[sort] || sorters.ending);
    res.json({ listings: list });
  });

  app.get('/api/stats', (req, res) => {
    const l = one("SELECT COUNT(*) AS n, COALESCE(SUM(qty_kg),0) AS kg FROM listings WHERE status != 'expired'");
    const v = one("SELECT COALESCE(SUM(winning_bid_cents),0) AS c FROM listings WHERE status = 'paid'");
    res.json({ listings: l.n, kg: Math.round(l.kg), tradedCents: v.c, users: one('SELECT COUNT(*) AS n FROM users').n });
  });

  app.get('/api/listings/:id', auth(false), (req, res) => {
    let l = one('SELECT * FROM listings WHERE id = ?', Number(req.params.id));
    if (!l) throw new HttpError(404, 'Listing not found');
    l = settle(l);
    const out = publicListing(l, req.user && req.user.id);
    out.bids = q(`SELECT b.amount_cents AS amountCents, b.created_at AS createdAt, u.name AS bidder
                  FROM bids b JOIN users u ON u.id = b.user_id WHERE b.listing_id = ?
                  ORDER BY b.amount_cents DESC, b.id ASC LIMIT 20`, l.id);
    res.json({ listing: out, serverTime: now() });
  });

  app.post('/api/listings/:id/bids', auth(true), (req, res) => {
    const id = Number(req.params.id);
    const cents = Math.round(Number(req.body && req.body.amount) * 100);
    if (!Number.isInteger(cents) || cents <= 0 || cents > 100_000_00) throw new HttpError(400, 'Enter a valid bid amount');
    tx(db, () => {
      const l = one('SELECT * FROM listings WHERE id = ?', id);
      if (!l) throw new HttpError(404, 'Listing not found');
      if (l.status !== 'open' || l.ends_at <= now()) throw new HttpError(409, 'This auction has ended');
      if (l.seller_id === req.user.id) throw new HttpError(403, "You can't bid on your own listing");
      const top = one('SELECT user_id, amount_cents FROM bids WHERE listing_id = ? ORDER BY amount_cents DESC, id ASC LIMIT 1', id);
      const min = top ? top.amount_cents + MIN_INCREMENT_CENTS : l.start_price_cents;
      if (cents < min) throw new HttpError(409, `Bid must be at least $${(min / 100).toFixed(2)}`);
      if (top && top.user_id === req.user.id) throw new HttpError(409, 'You already have the highest bid');
      run('INSERT INTO bids (listing_id, user_id, amount_cents, created_at) VALUES (?, ?, ?, ?)', id, req.user.id, cents, now());
      // Anti-sniping: a bid in the last 2 minutes extends the auction by 2 minutes.
      if (l.ends_at - now() < 120_000) run('UPDATE listings SET ends_at = ? WHERE id = ?', now() + 120_000, id);
    });
    res.status(201).json({ ok: true });
  });

  // ---------- payments ----------
  function winnerListing(req) {
    let l = one('SELECT * FROM listings WHERE id = ?', Number(req.params.id));
    if (!l) throw new HttpError(404, 'Listing not found');
    l = settle(l);
    if (l.winner_id !== req.user.id) throw new HttpError(403, 'Only the winning bidder can pay');
    return l;
  }

  app.post('/api/listings/:id/checkout', auth(true), wrap(async (req, res) => {
    const l = winnerListing(req);
    if (l.status === 'paid') throw new HttpError(409, 'Already paid');
    if (l.status !== 'closed') throw new HttpError(409, 'This listing is not awaiting payment');
    if (config.stripe) {
      const session = await config.stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: l.winning_bid_cents,
            product_data: { name: `${l.title} (${l.qty_kg} kg)` },
          },
        }],
        customer_email: req.user.email,
        client_reference_id: String(l.id),
        metadata: { listing_id: String(l.id) },
        success_url: `${config.baseUrl}/#/listing/${l.id}?paid=1`,
        cancel_url: `${config.baseUrl}/#/listing/${l.id}`,
      });
      run('UPDATE listings SET stripe_session_id = ? WHERE id = ?', session.id, l.id);
      return res.json({ url: session.url });
    }
    if (config.demoPayments) {
      run("UPDATE listings SET status = 'paid', stripe_session_id = 'demo' WHERE id = ?", l.id);
      return res.json({ demo: true });
    }
    throw new HttpError(503, 'Payments are not configured yet');
  }));

  // Called when the buyer returns from Stripe; confirms with Stripe directly
  // so it works even if the webhook has not arrived yet.
  app.post('/api/listings/:id/verify-payment', auth(true), wrap(async (req, res) => {
    const l = winnerListing(req);
    if (l.status === 'closed' && config.stripe && l.stripe_session_id && l.stripe_session_id !== 'demo') {
      const s = await config.stripe.checkout.sessions.retrieve(l.stripe_session_id);
      if (s.payment_status === 'paid') markPaid(l.id, s.id);
    }
    res.json({ status: one('SELECT status FROM listings WHERE id = ?', l.id).status });
  }));

  // ---------- dashboard ----------
  app.get('/api/me/activity', auth(true), (req, res) => {
    settleAllDue();
    const uid = req.user.id;
    const selling = q('SELECT * FROM listings WHERE seller_id = ? ORDER BY created_at DESC', uid).map((l) => publicListing(l, uid));
    const bidIds = q('SELECT DISTINCT listing_id FROM bids WHERE user_id = ?', uid).map((r) => r.listing_id);
    const bidding = bidIds.map((id) => publicListing(one('SELECT * FROM listings WHERE id = ?', id), uid))
      .map((l) => ({ ...l, leading: one('SELECT user_id FROM bids WHERE listing_id = ? ORDER BY amount_cents DESC, id ASC LIMIT 1', l.id).user_id === uid }))
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ selling, bidding });
  });

  // ---------- static ----------
  app.use('/uploads', express.static(uploadDir, {
    maxAge: '30d', immutable: true, index: false, dotfiles: 'deny',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be under 5 MB' : 'Too many files';
      return res.status(400).json({ error: msg });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  app.close = () => { clearInterval(timer); db.close(); };
  app.db = db;
  return app;
}

module.exports = { createApp };
