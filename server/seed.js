// Demo data for development: `npm run seed` (refuses to run in production).
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { openDb } = require('./db');

if (process.env.NODE_ENV === 'production') { console.error('Refusing to seed in production'); process.exit(1); }
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const db = openDb(dataDir);
const uploads = path.join(dataDir, 'uploads');
fs.mkdirSync(uploads, { recursive: true });

const colors = { Plastic: ['#3b82f6', '#93c5fd'], Metal: ['#64748b', '#cbd5e1'], Paper: ['#d97706', '#fcd34d'], Glass: ['#0d9488', '#99f6e4'], 'E-waste': ['#7c3aed', '#c4b5fd'], Organic: ['#16a34a', '#bbf7d0'], Textile: ['#db2777', '#fbcfe8'], Wood: ['#92400e', '#fdba74'] };
const icons = { Plastic: '🧴', Metal: '🔩', Paper: '📦', Glass: '🍾', 'E-waste': '🔌', Organic: '🌱', Textile: '👕', Wood: '🪵' };
function art(cat, label) {
  const [a, b] = colors[cat];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="640" height="480" fill="url(#g)"/><text x="320" y="270" font-size="170" text-anchor="middle">${icons[cat]}</text><text x="320" y="420" font-size="34" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff" fill-opacity=".9">${label}</text></svg>`;
}

const hash = bcrypt.hashSync('demo-password', 10);
const now = Date.now();
const mkUser = (email, name) => {
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  return u ? u.id : Number(db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?,?,?,?)').run(email, name, hash, now).lastInsertRowid);
};
const sellers = [mkUser('demo-seller1@example.com', 'GreenCycle Ltd'), mkUser('demo-seller2@example.com', 'Northside Recycling')];
const bidders = [mkUser('demo-bidder1@example.com', 'Maya R.'), mkUser('demo-bidder2@example.com', 'Tom K.'), mkUser('demo-bidder3@example.com', 'EcoHaul Co.')];

const items = [
  ['Rinsed PET bottles, baled', 'Plastic', 450, 'Leeds', 120, 26, 'Clean, colour-sorted PET bottles in five 90 kg bales. Forklift loading available weekdays.'],
  ['Aluminium offcuts and extrusions', 'Metal', 180, 'Birmingham', 210, 5, 'Clean 6063 aluminium offcuts from a window fabricator. No steel contamination.'],
  ['Cardboard bales (OCC)', 'Paper', 1200, 'Manchester', 95, 52, 'Old corrugated cardboard, dry and baled. Roughly 1.2 tonnes across 8 bales.'],
  ['Mixed cullet, clear glass', 'Glass', 800, 'Bristol', 60, 100, 'Crushed clear glass from a bottling plant. Delivered in bulk bags.'],
  ['Retired office laptops (untested)', 'E-waste', 65, 'London', 150, 3, '24 business laptops, 3-5 years old. Sold as untested for parts or refurbishment.'],
  ['Brewery spent grain', 'Organic', 600, 'Sheffield', 25, 20, 'Fresh spent grain, ideal for animal feed or composting. Collect within 24h of close.'],
  ['Offcut fabric rolls', 'Textile', 90, 'Leicester', 70, 140, 'End-of-roll cotton and poly-cotton blends from a garment factory.'],
  ['Pallet wood, heat treated', 'Wood', 300, 'Glasgow', 40, 70, 'Around 80 broken pallets, suitable for chipping or reclamation.'],
  ['HDPE crates and drums', 'Plastic', 320, 'Cardiff', 55, 8, 'Rinsed HDPE crates and 25 L drums, natural colour.'],
];
const insL = db.prepare(`INSERT INTO listings (seller_id,title,description,category,qty_kg,location,start_price_cents,ends_at,images,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
const insB = db.prepare('INSERT INTO bids (listing_id,user_id,amount_cents,created_at) VALUES (?,?,?,?)');
items.forEach(([title, cat, qty, loc, price, hours, desc], i) => {
  if (db.prepare('SELECT 1 FROM listings WHERE title = ?').get(title)) return;
  const file = `seed-${i}.svg`;
  fs.writeFileSync(path.join(uploads, file), art(cat, cat));
  const id = Number(insL.run(sellers[i % 2], title, desc, cat, qty, loc, price * 100, now + hours * 3600_000, JSON.stringify([file]), now - i * 3600_000).lastInsertRowid);
  let amount = price * 100;
  for (let k = 0; k < i % 4; k++) { amount += 500 + k * 250; insB.run(id, bidders[(i + k) % 3], amount, now - (10 - k) * 60_000); }
});
console.log('Seeded demo listings. Demo logins: demo-bidder1@example.com / demo-password');
db.close();
