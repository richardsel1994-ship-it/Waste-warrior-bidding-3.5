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
const nodemailer = require('nodemailer');
const { openDb, tx } = require('./db');
const { createCarrierChecker } = require('./carrier');

const CATEGORIES = ['Household', 'Garden', 'Furniture', 'Appliances', 'Building rubble', 'Mixed recycling', 'Commercial'];
const LOAD_SIZES = ['Single item', 'Quarter van', 'Half van', 'Full van', 'Skip-sized'];
// Reverse auction: each new bid must undercut the lowest bid by at least this much.
const MIN_DECREMENT_CENTS = 50;
const DAY_MS = 24 * 3600_000;
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
    mailFrom: opts.mailFrom || process.env.SMTP_FROM || process.env.SMTP_USER,
    mailer: opts.mailer !== undefined ? opts.mailer : (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
      ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: Number(process.env.SMTP_PORT || 587) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      })
      : null),
    demoPayments: opts.demoPayments !== undefined ? opts.demoPayments : process.env.DEMO_PAYMENTS === '1',
    production: process.env.NODE_ENV === 'production',
    stripe: opts.stripe,
    // Platform fee, charged once to the customer (added on top) and once to the provider (taken from their bid).
    feePercent: Number(opts.feePercent ?? process.env.PLATFORM_FEE_PERCENT ?? 10),
    // Waste Warrior Plus: a monthly subscription that lowers the customer's service fee.
    plusPriceId: opts.plusPriceId !== undefined ? opts.plusPriceId : process.env.STRIPE_PLUS_PRICE_ID,
    plusFeePercent: Number(opts.plusFeePercent ?? process.env.PLUS_FEE_PERCENT ?? 6),
    plusPricePence: Number(opts.plusPricePence ?? process.env.PLUS_PRICE_PENCE ?? 295),
    // Hauler Pro: a monthly subscription that lowers the fee taken from a hauler's winning bid.
    proPriceId: opts.proPriceId !== undefined ? opts.proPriceId : process.env.STRIPE_PRO_PRICE_ID,
    proFeePercent: Number(opts.proFeePercent ?? process.env.PRO_FEE_PERCENT ?? 6),
    proPricePence: Number(opts.proPricePence ?? process.env.PRO_PRICE_PENCE ?? 499),
  };
  if (!(config.feePercent >= 0 && config.feePercent < 50)) throw new Error('PLATFORM_FEE_PERCENT must be between 0 and 49');
  if (!(config.plusFeePercent >= 0 && config.plusFeePercent <= config.feePercent)) throw new Error('PLUS_FEE_PERCENT must be between 0 and PLATFORM_FEE_PERCENT');
  if (!(config.proFeePercent >= 0 && config.proFeePercent <= config.feePercent)) throw new Error('PRO_FEE_PERCENT must be between 0 and PLATFORM_FEE_PERCENT');
  if (!config.jwtSecret) {
    if (config.production) throw new Error('JWT_SECRET must be set in production');
    config.jwtSecret = crypto.randomBytes(32).toString('hex');
    console.warn('JWT_SECRET not set; using a random one (logins reset on restart).');
  }
  if (!config.stripe && config.stripeKey) config.stripe = require('stripe')(config.stripeKey);

  const carriers = opts.carrierChecker || createCarrierChecker();
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

  // Money split for an accepted bid. The customer pays bid + their fee; the provider is owed bid - their fee.
  // Plus subscribers (customers) and Hauler Pro subscribers (providers) each pay a lower fee.
  function fees(bidCents, customerPct = config.feePercent, providerPct = config.feePercent) {
    const cFee = Math.round(bidCents * customerPct / 100);
    const pFee = Math.round(bidCents * providerPct / 100);
    return {
      customerFeePercent: customerPct, customerFeeCents: cFee, customerTotalCents: bidCents + cFee,
      providerFeePercent: providerPct, providerFeeCents: pFee, providerPayoutCents: bidCents - pFee, platformCents: cFee + pFee,
    };
  }
  // Monthly plans. The key doubles as the users-table column prefix (plus_status, pro_status, ...).
  const PLANS = {
    plus: { name: 'Waste Warrior Plus', who: 'customer', priceId: config.plusPriceId, feePercent: config.plusFeePercent, pricePence: config.plusPricePence },
    pro: { name: 'Hauler Pro', who: 'hauler', priceId: config.proPriceId, feePercent: config.proFeePercent, pricePence: config.proPricePence },
  };
  const planAvailable = (p) => Boolean((config.stripe && PLANS[p].priceId) || config.demoPayments);
  function onPlan(u, p) {
    return Boolean(u && ['active', 'trialing'].includes(u[`${p}_status`]) && (!u[`${p}_until`] || u[`${p}_until`] > now()));
  }
  const isPlus = (u) => onPlan(u, 'plus');
  const isPro = (u) => onPlan(u, 'pro');
  // The fees for a job right now, or the ones fixed when the customer started paying for it.
  function customerPctFor(listing, seller) {
    if (listing.customer_fee_pct != null) return listing.customer_fee_pct;
    return isPlus(seller) ? config.plusFeePercent : config.feePercent;
  }
  function providerPctFor(listing, winner) {
    if (listing.provider_fee_pct != null) return listing.provider_fee_pct;
    return isPro(winner) ? config.proFeePercent : config.feePercent;
  }

  // Lowest price wins; on a tie the earlier bid wins.
  const lowestBid = (listingId) => one('SELECT user_id, amount_cents FROM bids WHERE listing_id = ? ORDER BY amount_cents ASC, id ASC LIMIT 1', listingId);

  function settle(listing) {
    if (!listing || listing.status !== 'open' || listing.ends_at > now()) return listing;
    tx(db, () => {
      const l = one('SELECT * FROM listings WHERE id = ?', listing.id);
      if (l.status !== 'open') return;
      const low = lowestBid(l.id);
      if (low) run("UPDATE listings SET status = 'closed', winner_id = ?, winning_bid_cents = ? WHERE id = ?", low.user_id, low.amount_cents, l.id);
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
    const low = one('SELECT MIN(amount_cents) AS m, COUNT(*) AS n FROM bids WHERE listing_id = ?', l.id);
    const customer = one('SELECT name, email, plus_status, plus_until FROM users WHERE id = ?', l.seller_id);
    const winner = l.winner_id ? one('SELECT name, email, pro_status, pro_until FROM users WHERE id = ?', l.winner_id) : null;
    const current = low.n ? low.m : l.start_price_cents;
    const isSeller = userId === l.seller_id;
    const isWinner = l.winner_id != null && userId === l.winner_id;
    const out = {
      id: l.id, title: l.title, description: l.description, category: l.category,
      loadSize: l.load_size, location: l.location, accessNotes: l.access_notes,
      collectFrom: l.collect_from, collectBy: l.collect_by, images: JSON.parse(l.images),
      startPriceCents: l.start_price_cents, currentBidCents: current, bidCount: low.n,
      maxNextBidCents: low.n ? current - MIN_DECREMENT_CENTS : l.start_price_cents,
      endsAt: l.ends_at, status: l.status, sellerName: customer.name,
      isSeller, isWinner,
      winnerName: winner ? winner.name : null,
      winningBidCents: l.winning_bid_cents,
      createdAt: l.created_at,
    };
    if (l.winning_bid_cents != null) {
      const f = fees(l.winning_bid_cents, customerPctFor(l, customer), providerPctFor(l, winner));
      if (isSeller) Object.assign(out, { customerFeePercent: f.customerFeePercent, customerFeeCents: f.customerFeeCents, customerTotalCents: f.customerTotalCents });
      if (isWinner) Object.assign(out, { providerFeePercent: f.providerFeePercent, providerFeeCents: f.providerFeeCents, providerPayoutCents: f.providerPayoutCents });
    }
    // The full address and contact details are private until the job is booked.
    if (isSeller) out.address = l.address;
    if (l.status === 'paid' && isWinner) Object.assign(out, { address: l.address, contact: { name: customer.name, email: customer.email } });
    if (l.status === 'paid' && isSeller) out.contact = { name: winner.name, email: winner.email };
    return out;
  }

  // A hauler's waste carrier registration as shown to other people.
  const RECHECK_MS = 7 * DAY_MS;
  function carrierInfo(u) {
    if (!u || !u.carrier_number) return null;
    let status = u.carrier_status;
    if (status === 'registered' && u.carrier_expires && Date.parse(`${u.carrier_expires}T23:59:59Z`) < now()) status = 'expired';
    return {
      number: u.carrier_number, status, verified: status === 'registered',
      name: u.carrier_name, tier: u.carrier_tier, expiresOn: u.carrier_expires, checkedAt: u.carrier_checked_at,
      registerUrl: `https://environment.data.gov.uk/public-register/waste-carriers-brokers/registration/${encodeURIComponent(u.carrier_number)}`,
    };
  }
  function saveCarrier(userId, r) {
    run(`UPDATE users SET carrier_number = ?, carrier_status = ?, carrier_name = ?, carrier_tier = ?, carrier_expires = ?, carrier_checked_at = ? WHERE id = ?`,
      r.number, r.status, r.name || '', r.tier || '', r.expiresOn || '', now(), userId);
  }
  const USER_COLS = 'id, email, name, carrier_number, carrier_status, carrier_name, carrier_tier, carrier_expires, carrier_checked_at, '
    + 'stripe_customer_id, plus_subscription_id, plus_status, plus_until, plus_cancel_at_end, plus_session_id, '
    + 'pro_subscription_id, pro_status, pro_until, pro_cancel_at_end, pro_session_id';
  const planJson = (u, p) => ({ active: onPlan(u, p), status: u[`${p}_status`] || null, until: u[`${p}_until`] || null, cancelAtEnd: Boolean(u[`${p}_cancel_at_end`]) });
  const meJson = (u) => (u ? { id: u.id, email: u.email, name: u.name, carrier: carrierInfo(u), plus: planJson(u, 'plus'), pro: planJson(u, 'pro') } : null);

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  function auth(required) {
    return (req, res, next) => {
      const token = req.cookies && req.cookies.token;
      req.user = null;
      if (token) {
        try {
          const { sub } = jwt.verify(token, config.jwtSecret);
          req.user = one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, sub) || null;
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
  // Store a subscription's state against the user and plan it belongs to.
  function syncSubscription(sub, userId, planHint) {
    if (!sub) return;
    let plan = planHint || (sub.metadata && sub.metadata.plan);
    if (!PLANS[plan]) plan = Object.keys(PLANS).find((p) => one(`SELECT 1 FROM users WHERE ${p}_subscription_id = ?`, sub.id)) || 'plus';
    const uid = userId || Number(sub.metadata && sub.metadata.user_id)
      || (one(`SELECT id FROM users WHERE ${plan}_subscription_id = ?`, sub.id) || {}).id;
    if (!uid) return;
    const periodEnd = sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end) || null;
    const customer = typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || '';
    run(`UPDATE users SET ${plan}_subscription_id = ?, ${plan}_status = ?, ${plan}_until = ?, ${plan}_cancel_at_end = ?,
           stripe_customer_id = CASE WHEN ? != '' THEN ? ELSE stripe_customer_id END WHERE id = ?`,
      sub.id, sub.status, periodEnd ? periodEnd * 1000 : null, sub.cancel_at_period_end ? 1 : 0, customer, customer, uid);
  }

  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), wrap(async (req, res) => {
    if (!config.stripe || !config.stripeWebhookSecret) return res.status(503).end();
    let event;
    try {
      event = config.stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripeWebhookSecret);
    } catch {
      return res.status(400).send('Bad signature');
    }
    const o = event.data.object;
    if (event.type === 'checkout.session.completed') {
      if (o.mode === 'subscription' && o.subscription) {
        const sub = typeof o.subscription === 'string' ? await config.stripe.subscriptions.retrieve(o.subscription) : o.subscription;
        syncSubscription(sub, Number(o.metadata && o.metadata.user_id) || Number(o.client_reference_id) || null, o.metadata && o.metadata.plan);
      } else if (o.payment_status === 'paid') {
        markPaid(Number(o.metadata && o.metadata.listing_id), o.id);
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.created') {
      syncSubscription(o);
    }
    res.json({ received: true });
  }));

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
    res.status(201).json({ user: meJson(one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, Number(r.lastInsertRowid))) });
  }));

  app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
    const { email = '', password = '' } = req.body || {};
    const u = one('SELECT * FROM users WHERE email = ?', String(email).trim().toLowerCase());
    const ok = u && typeof password === 'string' && await bcrypt.compare(password, u.password_hash);
    if (!ok) throw new HttpError(401, 'Wrong email or password');
    setSession(res, u.id);
    res.json({ user: meJson(one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, u.id)) });
  }));

  app.post('/api/auth/forgot-password', authLimiter, wrap(async (req, res) => {
    if (!config.mailer || !config.mailFrom) throw new HttpError(503, 'Password recovery email is not configured. Please contact support.');
    const email = String(req.body && req.body.email || '').trim().toLowerCase();
    const user = one('SELECT id FROM users WHERE email = ?', email);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      run('DELETE FROM password_resets WHERE user_id = ?', user.id);
      run('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)', user.id, tokenHash, now() + 60 * 60_000);
      try {
        await config.mailer.sendMail({
          from: config.mailFrom,
          to: email,
          subject: 'Reset your Waste Warrior Bidding password',
          text: `Use this link to choose a new password. It expires in one hour:\n\n${config.baseUrl}/#/reset-password?token=${token}\n\nIf you did not request this, ignore this email.`,
        });
      } catch (error) {
        run('DELETE FROM password_resets WHERE user_id = ?', user.id);
        console.error('Password reset email failed:', error);
      }
    }
    res.json({ message: 'If an account exists for that email, password reset instructions will be sent.' });
  }));

  app.post('/api/auth/reset-password', authLimiter, wrap(async (req, res) => {
    const token = String(req.body && req.body.token || '');
    const password = req.body && req.body.password;
    if (!/^[a-f\d]{64}$/i.test(token)) throw new HttpError(400, 'This reset link is invalid or expired. Request a new one.');
    if (typeof password !== 'string' || password.length < 8 || password.length > 100) throw new HttpError(400, 'Password must be 8-100 characters');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const reset = one('SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > ?', tokenHash, now());
    if (!reset) throw new HttpError(400, 'This reset link is invalid or expired. Request a new one.');
    const passwordHash = await bcrypt.hash(password, 10);
    tx(db, () => {
      const current = one('SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > ?', tokenHash, now());
      if (!current) throw new HttpError(400, 'This reset link is invalid or expired. Request a new one.');
      run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, current.user_id);
      run('DELETE FROM password_resets WHERE user_id = ?', current.user_id);
    });
    res.json({ ok: true });
  }));

  app.post('/api/auth/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
  app.get('/api/me', auth(false), (req, res) => res.json({ user: meJson(req.user) }));

  // ---------- config for the client ----------
  app.get('/api/config', (req, res) => res.json({
    categories: CATEGORIES,
    loadSizes: LOAD_SIZES,
    feePercent: config.feePercent,
    plus: { available: planAvailable('plus'), feePercent: PLANS.plus.feePercent, pricePence: PLANS.plus.pricePence },
    pro: { available: planAvailable('pro'), feePercent: PLANS.pro.feePercent, pricePence: PLANS.pro.pricePence },
    maxImages: MAX_IMAGES,
    paymentMode: config.stripe ? 'stripe' : config.demoPayments ? 'demo' : 'off',
  }));

  // ---------- listings ----------
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: MAX_IMAGES, fields: 20 },
  });

  // Collection window as YYYY-MM-DD dates. Bidding must close before the last collection day.
  function parseDates(from, by, biddingEnds) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const day = (v) => (re.test(String(v)) ? Date.parse(`${v}T00:00:00Z`) : NaN);
    const f = day(from), t = day(by);
    if (Number.isNaN(f) || Number.isNaN(t)) throw new HttpError(400, 'Choose the dates the waste can be collected');
    if (t < f) throw new HttpError(400, 'The last collection date must be on or after the first');
    if (f < now() - 2 * DAY_MS || t > now() + 180 * DAY_MS) throw new HttpError(400, 'Collection dates must be within the next 6 months');
    if (t + DAY_MS <= biddingEnds) throw new HttpError(400, 'Bidding must close before the last collection date. Pick a later date or shorter bidding time.');
    return { collectFrom: String(from), collectBy: String(by) };
  }

  app.post('/api/listings', auth(true), upload.array('images', MAX_IMAGES), wrap(async (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    const description = String(b.description || '').trim();
    const location = String(b.location || '').trim();
    const address = String(b.address || '').trim();
    const accessNotes = String(b.accessNotes || '').trim();
    const startCents = Math.round(Number(b.startPrice) * 100);
    const hours = Number(b.durationHours);
    if (title.length < 3 || title.length > 80) throw new HttpError(400, 'Title must be 3-80 characters');
    if (description.length < 10 || description.length > 2000) throw new HttpError(400, 'Description must be 10-2000 characters');
    if (!CATEGORIES.includes(b.category)) throw new HttpError(400, 'Choose a valid waste type');
    if (!LOAD_SIZES.includes(b.loadSize)) throw new HttpError(400, 'Choose how much waste there is');
    if (location.length < 2 || location.length > 100) throw new HttpError(400, 'Enter the town or postcode area');
    if (address.length < 5 || address.length > 200) throw new HttpError(400, 'Enter the collection address');
    if (accessNotes.length > 500) throw new HttpError(400, 'Access notes must be under 500 characters');
    if (!Number.isInteger(startCents) || startCents < 100 || startCents > 100_000_00) throw new HttpError(400, 'Maximum budget must be between £1 and £100,000');
    if (!Number.isInteger(hours) || hours < 1 || hours >= 24) throw new HttpError(400, 'Choose a bidding time between 1 and 23 hours');
    const { collectFrom, collectBy } = parseDates(b.collectFrom, b.collectBy, now() + hours * 3600_000);
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
      `INSERT INTO listings (seller_id, title, description, category, load_size, location, address, access_notes,
         collect_from, collect_by, start_price_cents, ends_at, images, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      req.user.id, title, description, b.category, b.loadSize, location, address, accessNotes,
      collectFrom, collectBy, startCents, now() + hours * 3600_000, JSON.stringify(names), now());
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
      list = list.filter((l) => (l.title + ' ' + l.description + ' ' + l.location + ' ' + l.category).toLowerCase().includes(s));
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
    const l = one("SELECT COUNT(*) AS n FROM listings WHERE status != 'expired'");
    const v = one("SELECT COUNT(*) AS n, COALESCE(SUM(start_price_cents - winning_bid_cents),0) AS saved FROM listings WHERE status = 'paid'");
    res.json({ listings: l.n, booked: v.n, savedCents: v.saved, users: one('SELECT COUNT(*) AS n FROM users').n });
  });

  app.get('/api/listings/:id', auth(false), (req, res) => {
    let l = one('SELECT * FROM listings WHERE id = ?', Number(req.params.id));
    if (!l) throw new HttpError(404, 'Job not found');
    l = settle(l);
    const out = publicListing(l, req.user && req.user.id);
    out.bids = q(`SELECT b.amount_cents AS amountCents, b.created_at AS createdAt, u.name AS bidder,
                         u.carrier_number, u.carrier_status, u.carrier_name, u.carrier_tier, u.carrier_expires, u.carrier_checked_at
                  FROM bids b JOIN users u ON u.id = b.user_id WHERE b.listing_id = ?
                  ORDER BY b.amount_cents ASC, b.id ASC LIMIT 20`, l.id)
      .map((b) => {
        const c = carrierInfo(b);
        return { amountCents: b.amountCents, createdAt: b.createdAt, bidder: b.bidder, carrier: c && { number: c.number, verified: c.verified, registerUrl: c.registerUrl } };
      });
    res.json({ listing: out, serverTime: now() });
  });

  app.post('/api/listings/:id/bids', auth(true), (req, res) => {
    const id = Number(req.params.id);
    const cents = Math.round(Number(req.body && req.body.amount) * 100);
    if (!Number.isInteger(cents) || cents <= 0 || cents > 100_000_00) throw new HttpError(400, 'Enter a valid bid amount');
    tx(db, () => {
      const l = one('SELECT * FROM listings WHERE id = ?', id);
      if (!l) throw new HttpError(404, 'Job not found');
      if (l.status !== 'open' || l.ends_at <= now()) throw new HttpError(409, 'Bidding on this job has closed');
      if (l.seller_id === req.user.id) throw new HttpError(403, "You can't bid on your own job");
      const low = lowestBid(id);
      const max = low ? low.amount_cents - MIN_DECREMENT_CENTS : l.start_price_cents;
      if (low && low.user_id === req.user.id) throw new HttpError(409, 'You already have the lowest bid');
      if (max < 100) throw new HttpError(409, 'Bids can’t go any lower on this job');
      if (cents > max) throw new HttpError(409, `Bid must be £${(max / 100).toFixed(2)} or less`);
      if (cents < 100) throw new HttpError(400, 'Bids must be at least £1');
      run('INSERT INTO bids (listing_id, user_id, amount_cents, created_at) VALUES (?, ?, ?, ?)', id, req.user.id, cents, now());
      // Anti-sniping: a bid in the last 2 minutes extends the auction by 2 minutes.
      if (l.ends_at - now() < 120_000) run('UPDATE listings SET ends_at = ? WHERE id = ?', now() + 120_000, id);
    });
    res.status(201).json({ ok: true });
  });

  // ---------- monthly plans: Plus (customers) and Hauler Pro (haulers) ----------
  const meRow = (id) => one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, id);

  for (const [p, plan] of Object.entries(PLANS)) {
    app.post(`/api/${p}/checkout`, auth(true), wrap(async (req, res) => {
      if (onPlan(req.user, p)) throw new HttpError(409, `You already have ${plan.name}`);
      if (config.stripe && plan.priceId) {
        const session = await config.stripe.checkout.sessions.create({
          mode: 'subscription',
          line_items: [{ price: plan.priceId, quantity: 1 }],
          ...(req.user.stripe_customer_id ? { customer: req.user.stripe_customer_id } : { customer_email: req.user.email }),
          client_reference_id: String(req.user.id),
          metadata: { user_id: String(req.user.id), plan: p },
          subscription_data: { metadata: { user_id: String(req.user.id), plan: p } },
          success_url: `${config.baseUrl}/#/plus?subscribed=${p}`,
          cancel_url: `${config.baseUrl}/#/plus`,
        });
        run(`UPDATE users SET ${p}_session_id = ? WHERE id = ?`, session.id, req.user.id);
        return res.json({ url: session.url });
      }
      if (config.demoPayments) {
        run(`UPDATE users SET ${p}_status = 'active', ${p}_until = ?, ${p}_cancel_at_end = 0, ${p}_subscription_id = 'demo' WHERE id = ?`, now() + 30 * DAY_MS, req.user.id);
        return res.json({ demo: true, user: meJson(meRow(req.user.id)) });
      }
      throw new HttpError(503, 'Subscriptions are not available yet');
    }));

    // Called on return from Stripe, so the plan starts even before the webhook arrives.
    app.post(`/api/${p}/verify`, auth(true), wrap(async (req, res) => {
      const u = req.user;
      if (config.stripe && u[`${p}_session_id`] && !onPlan(u, p)) {
        const s = await config.stripe.checkout.sessions.retrieve(u[`${p}_session_id`]);
        if (s.status === 'complete' && s.subscription) {
          const sub = typeof s.subscription === 'string' ? await config.stripe.subscriptions.retrieve(s.subscription) : s.subscription;
          syncSubscription(sub, u.id, p);
        }
      }
      res.json({ user: meJson(meRow(u.id)) });
    }));

    // Cancel at the end of the paid month, or undo that.
    const setCancel = async (req, res, cancel) => {
      const u = req.user;
      const subId = u[`${p}_subscription_id`];
      if (!subId || !onPlan(u, p)) throw new HttpError(409, `You don’t have an active ${plan.name} subscription`);
      if (subId === 'demo' || !config.stripe) {
        run(`UPDATE users SET ${p}_cancel_at_end = ? WHERE id = ?`, cancel ? 1 : 0, u.id);
      } else {
        syncSubscription(await config.stripe.subscriptions.update(subId, { cancel_at_period_end: cancel }), u.id, p);
      }
      res.json({ user: meJson(meRow(u.id)) });
    };
    app.post(`/api/${p}/cancel`, auth(true), wrap((req, res) => setCancel(req, res, true)));
    app.post(`/api/${p}/resume`, auth(true), wrap((req, res) => setCancel(req, res, false)));
  }

  // ---------- haulers and waste carrier checks ----------
  const checkLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  // Anyone can check a number against the Environment Agency register.
  app.get('/api/carriers/check', checkLimiter, wrap(async (req, res) => {
    res.json({ result: await carriers.check(req.query.number) });
  }));

  // A hauler adds (or removes) their own waste carrier number. It is only saved once the register confirms it.
  app.put('/api/me/carrier', auth(true), checkLimiter, wrap(async (req, res) => {
    const number = String(req.body && req.body.number || '').trim();
    if (!number) {
      run("UPDATE users SET carrier_number = '', carrier_status = '', carrier_name = '', carrier_tier = '', carrier_expires = '', carrier_checked_at = NULL WHERE id = ?", req.user.id);
      return res.json({ user: meJson(one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, req.user.id)) });
    }
    const r = await carriers.check(number);
    const msgs = {
      invalid: 'That isn’t a waste carrier number. English and Welsh numbers start CBDU or CBDL, e.g. CBDU123456.',
      other_region: `This looks like a ${r.region} registration. At the moment we can only verify numbers on the Environment Agency register.`,
      not_found: `${r.number} isn’t on the Environment Agency register. Check the number on your registration certificate.`,
      expired: `${r.number} has expired on the register. Renew it with the Environment Agency, then add it again.`,
      unavailable: 'We couldn’t reach the Environment Agency register just now. Please try again in a few minutes.',
    };
    if (r.status !== 'registered') throw new HttpError(r.status === 'unavailable' ? 503 : 400, msgs[r.status] || 'That number could not be verified');
    const taken = one('SELECT id FROM users WHERE carrier_number = ? AND id != ?', r.number, req.user.id);
    if (taken) throw new HttpError(409, 'That waste carrier number is already linked to another account. Contact support if it’s yours.');
    saveCarrier(req.user.id, r);
    res.json({ user: meJson(one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, req.user.id)) });
  }));

  // Haulers with a verified registration, most jobs first.
  app.get('/api/haulers', (req, res) => {
    const rows = q(`SELECT ${USER_COLS},
        (SELECT COUNT(*) FROM listings l WHERE l.winner_id = users.id AND l.status = 'paid') AS jobs
      FROM users WHERE carrier_number != '' AND carrier_status = 'registered'
      ORDER BY jobs DESC, carrier_checked_at DESC LIMIT 200`);
    // Re-check registrations that haven't been looked at for a week, in the background.
    for (const u of rows.filter((r) => !r.carrier_checked_at || r.carrier_checked_at < now() - RECHECK_MS).slice(0, 5)) {
      carriers.check(u.carrier_number).then((r) => { if (r.status !== 'unavailable') saveCarrier(u.id, r); }).catch(() => {});
    }
    const haulers = rows.map((u) => ({ name: u.name, jobs: u.jobs, carrier: carrierInfo(u) }))
      .filter((h) => h.carrier.verified);
    res.json({ haulers });
  });

  // ---------- accepting the winner and paying ----------
  // The customer who posted the job accepts the lowest bid by paying for it, or declines it.
  function customerJob(req) {
    let l = one('SELECT * FROM listings WHERE id = ?', Number(req.params.id));
    if (!l) throw new HttpError(404, 'Job not found');
    l = settle(l);
    if (l.seller_id !== req.user.id) throw new HttpError(403, 'Only the customer who posted this job can do that');
    return l;
  }

  app.post('/api/listings/:id/decline', auth(true), (req, res) => {
    const l = customerJob(req);
    if (l.status !== 'closed') throw new HttpError(409, 'This job is not waiting for you to accept a bid');
    run("UPDATE listings SET status = 'cancelled' WHERE id = ? AND status = 'closed'", l.id);
    res.json({ status: 'cancelled' });
  });

  app.post('/api/listings/:id/checkout', auth(true), wrap(async (req, res) => {
    const l = customerJob(req);
    if (l.status === 'paid') throw new HttpError(409, 'Already paid');
    if (l.status !== 'closed') throw new HttpError(409, 'This job is not waiting for payment');
    const seller = one('SELECT plus_status, plus_until FROM users WHERE id = ?', l.seller_id);
    const winner = one('SELECT pro_status, pro_until FROM users WHERE id = ?', l.winner_id);
    const pct = isPlus(seller) ? config.plusFeePercent : config.feePercent;
    const ppct = isPro(winner) ? config.proFeePercent : config.feePercent;
    if (config.stripe) {
      const f = fees(l.winning_bid_cents, pct, ppct);
      const item = (name, amount) => ({ quantity: 1, price_data: { currency: 'gbp', unit_amount: amount, product_data: { name } } });
      const session = await config.stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          item(`Waste collection: ${l.title}`, l.winning_bid_cents),
          ...(f.customerFeeCents ? [item(`Service fee (${pct}%${pct !== config.feePercent ? ', Plus member' : ''})`, f.customerFeeCents)] : []),
        ],
        customer_email: req.user.email,
        client_reference_id: String(l.id),
        metadata: {
          listing_id: String(l.id),
          provider_id: String(l.winner_id),
          provider_payout_pence: String(f.providerPayoutCents),
          platform_fee_pence: String(f.platformCents),
        },
        success_url: `${config.baseUrl}/#/listing/${l.id}?paid=1`,
        cancel_url: `${config.baseUrl}/#/listing/${l.id}`,
      });
      run('UPDATE listings SET stripe_session_id = ?, customer_fee_pct = ?, provider_fee_pct = ? WHERE id = ?', session.id, pct, ppct, l.id);
      return res.json({ url: session.url });
    }
    if (config.demoPayments) {
      run("UPDATE listings SET status = 'paid', stripe_session_id = 'demo', customer_fee_pct = ?, provider_fee_pct = ? WHERE id = ?", pct, ppct, l.id);
      return res.json({ demo: true });
    }
    throw new HttpError(503, 'Payments are not configured yet');
  }));

  // Called when the customer returns from Stripe; confirms with Stripe directly
  // so it works even if the webhook has not arrived yet.
  app.post('/api/listings/:id/verify-payment', auth(true), wrap(async (req, res) => {
    const l = customerJob(req);
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
      .map((l) => ({ ...l, leading: lowestBid(l.id).user_id === uid }))
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
