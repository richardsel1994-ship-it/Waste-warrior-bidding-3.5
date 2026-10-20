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

const colors = { Household: ['#3b82f6', '#93c5fd'], Garden: ['#16a34a', '#bbf7d0'], Furniture: ['#92400e', '#fdba74'], Appliances: ['#0d9488', '#99f6e4'], 'Building rubble': ['#64748b', '#cbd5e1'], 'Mixed recycling': ['#7c3aed', '#c4b5fd'], Commercial: ['#d97706', '#fcd34d'] };
const icons = { Household: '🏠', Garden: '🌿', Furniture: '🛋', Appliances: '🧊', 'Building rubble': '🧱', 'Mixed recycling': '♻', Commercial: '🏢' };
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
const customers = [mkUser('demo-customer1@example.com', 'Sarah P.'), mkUser('demo-customer2@example.com', 'Northside Cafe')];
const providers = [mkUser('demo-provider1@example.com', 'QuickClear Removals'), mkUser('demo-provider2@example.com', 'Tom K. Man & Van'), mkUser('demo-provider3@example.com', 'EcoHaul Co.')];
const day = (n) => new Date(now + n * 86400_000).toISOString().slice(0, 10);

// [title, type, size, area, budget £, bidding hours, collect from (days), collect by (days), access notes, description]
const items = [
  ['Old sofa and armchair', 'Furniture', 'Half van', 'Leeds LS6', 120, 26, 2, 6, 'Ground floor, front door. Parking outside.', 'Three-seater sofa and matching armchair, no fire labels so can’t be donated.'],
  ['Garden clearance after hedge cut', 'Garden', 'Full van', 'Birmingham B13', 180, 5, 1, 4, 'Bags are by the side gate. Narrow path, no steps.', 'About 15 bags of hedge cuttings plus some branches up to 2 m long.'],
  ['Kitchen strip-out rubble', 'Building rubble', 'Skip-sized', 'Manchester M20', 350, 52, 3, 10, 'Driveway access for a large van. Rubble is bagged.', 'Old kitchen units, tiles and plasterboard from a refit. Roughly 30 rubble sacks.'],
  ['Fridge freezer and washing machine', 'Appliances', 'Quarter van', 'Bristol BS5', 90, 30, 2, 7, 'Ground floor flat, two steps at the front door.', 'Both working but old. Fridge has been defrosted.'],
  ['Office clear-out, 20 boxes', 'Commercial', 'Full van', 'London EC1', 250, 3, 1, 3, 'Loading bay at the rear, 8am to 5pm. Lift to 3rd floor.', 'Archive boxes of paper (not confidential) and a few broken chairs.'],
  ['Loft clear-out', 'Household', 'Half van', 'Sheffield S11', 140, 20, 2, 8, 'Items will be brought down to the hallway before collection.', 'Old toys, suitcases, a broken exercise bike and bags of clothes.'],
  ['Cardboard and plastic after house move', 'Mixed recycling', 'Quarter van', 'Leicester LE2', 60, 70, 4, 9, 'Flattened boxes stacked in the garage.', 'Moving boxes and bubble wrap, all clean and dry.'],
  ['Single mattress', 'Furniture', 'Single item', 'Glasgow G12', 45, 8, 1, 5, '2nd floor tenement, no lift.', 'Single mattress in a plastic cover.'],
];
const insL = db.prepare(`INSERT INTO listings (seller_id,title,description,category,load_size,location,address,access_notes,collect_from,collect_by,start_price_cents,ends_at,images,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insB = db.prepare('INSERT INTO bids (listing_id,user_id,amount_cents,created_at) VALUES (?,?,?,?)');
items.forEach(([title, cat, size, area, budget, hours, from, by, access, desc], i) => {
  if (db.prepare('SELECT 1 FROM listings WHERE title = ?').get(title)) return;
  const file = `seed-${i}.svg`;
  fs.writeFileSync(path.join(uploads, file), art(cat, cat));
  const id = Number(insL.run(customers[i % 2], title, desc, cat, size, area, `${10 + i} Demo Street, ${area}`, access, day(from), day(by),
    budget * 100, now + hours * 3600_000, JSON.stringify([file]), now - i * 3600_000).lastInsertRowid);
  let amount = budget * 100;
  for (let k = 0; k < i % 4; k++) { amount -= 500 + k * 250; insB.run(id, providers[(i + k) % 3], amount, now - (10 - k) * 60_000); }
});
console.log('Seeded demo jobs. Demo logins: demo-customer1@example.com or demo-provider1@example.com / demo-password');
db.close();
