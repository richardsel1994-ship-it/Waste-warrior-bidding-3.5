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
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY,
      seller_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      qty_kg REAL NOT NULL,
      location TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_bids_listing ON bids(listing_id, amount_cents DESC);
    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, ends_at);
  `);
  return db;
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
