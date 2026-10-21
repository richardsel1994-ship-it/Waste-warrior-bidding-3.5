const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY,
      seller_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      load_size TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      access_notes TEXT NOT NULL DEFAULT '',
      collect_from TEXT NOT NULL DEFAULT '',
      collect_by TEXT NOT NULL DEFAULT '',
      start_price_cents INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      images TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      winner_id INTEGER REFERENCES users(id),
      winning_bid_cents INTEGER,
      stripe_session_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bids (
      id INTEGER PRIMARY KEY,
      listing_id INTEGER NOT NULL REFERENCES listings(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount_cents INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY,
      listing_id INTEGER NOT NULL UNIQUE REFERENCES listings(id),
      hauler_id INTEGER NOT NULL REFERENCES users(id),
      customer_id INTEGER NOT NULL REFERENCES users(id),
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_hauler ON reviews(hauler_id);
    CREATE INDEX IF NOT EXISTS idx_bids_listing ON bids(listing_id, amount_cents DESC);
    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, ends_at);
  `);
  migrate(db);
  return db;
}

// Bring databases made before listings became jobs up to the current schema.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(listings)').all().map((c) => c.name);
  const add = {
    load_size: "TEXT NOT NULL DEFAULT ''",
    address: "TEXT NOT NULL DEFAULT ''",
    access_notes: "TEXT NOT NULL DEFAULT ''",
    collect_from: "TEXT NOT NULL DEFAULT ''",
    collect_by: "TEXT NOT NULL DEFAULT ''",
    // The customer's service fee percentage, fixed when they start paying
    customer_fee_pct: 'REAL',
    // The hauler's fee percentage, fixed at the same time
    provider_fee_pct: 'REAL',
    // Paying the hauler their share through Stripe Connect: '', 'pending', 'sent', 'failed' or 'demo'
    payout_status: "TEXT NOT NULL DEFAULT ''",
    payout_transfer_id: "TEXT NOT NULL DEFAULT ''",
    payout_error: "TEXT NOT NULL DEFAULT ''",
    // Confirming the collection before the hauler is paid
    paid_at: 'INTEGER',
    collected_at: 'INTEGER', // the hauler marked the job collected
    completed_at: 'INTEGER', // the customer confirmed, an admin released it, or it was released automatically
    auto_released: 'INTEGER NOT NULL DEFAULT 0',
    release_at: 'INTEGER', // when the payout is released if the customer doesn't respond
    problem_at: 'INTEGER', // the customer reported a problem: the payout is held
    problem_note: "TEXT NOT NULL DEFAULT ''",
  };
  for (const [name, type] of Object.entries(add)) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${type}`);
  }
  // Jobs paid before collections had to be confirmed keep paying out as they did then.
  if (!cols.includes('completed_at')) db.exec("UPDATE listings SET completed_at = created_at WHERE status = 'paid'");
  if (cols.includes('qty_kg')) db.exec('ALTER TABLE listings DROP COLUMN qty_kg');

  // Waste carrier registration, for people who collect waste (haulers).
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const addUser = {
    carrier_number: "TEXT NOT NULL DEFAULT ''",
    carrier_status: "TEXT NOT NULL DEFAULT ''",
    carrier_name: "TEXT NOT NULL DEFAULT ''",
    carrier_tier: "TEXT NOT NULL DEFAULT ''",
    carrier_expires: "TEXT NOT NULL DEFAULT ''",
    carrier_checked_at: 'INTEGER',
    // Waste Warrior Plus subscription (customers pay a lower service fee)
    stripe_customer_id: "TEXT NOT NULL DEFAULT ''",
    plus_subscription_id: "TEXT NOT NULL DEFAULT ''",
    plus_status: "TEXT NOT NULL DEFAULT ''",
    plus_until: 'INTEGER',
    plus_cancel_at_end: 'INTEGER NOT NULL DEFAULT 0',
    plus_session_id: "TEXT NOT NULL DEFAULT ''",
    // Hauler Pro subscription (haulers keep more of each winning bid)
    pro_subscription_id: "TEXT NOT NULL DEFAULT ''",
    pro_status: "TEXT NOT NULL DEFAULT ''",
    pro_until: 'INTEGER',
    pro_cancel_at_end: 'INTEGER NOT NULL DEFAULT 0',
    pro_session_id: "TEXT NOT NULL DEFAULT ''",
    // Hauler payouts: their Stripe Connect Express account, where Stripe holds their bank or debit card details
    stripe_account_id: "TEXT NOT NULL DEFAULT ''",
    payouts_enabled: 'INTEGER NOT NULL DEFAULT 0',
    payouts_details_submitted: 'INTEGER NOT NULL DEFAULT 0',
  };
  for (const [name, type] of Object.entries(addUser)) {
    if (!userCols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
}

// Run fn inside an immediate transaction so concurrent bids serialize.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, tx };
