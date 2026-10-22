// Typical UK prices (outside London, including VAT) for having waste collected by a
// licensed carrier, used to suggest a starting price when a customer posts a job.
// Figures in pounds as [low, high]. Researched October 2026 from:
//   Fantastic Services cost guides (furniture disposal, rubbish removal, house, garden
//   and shed clearance) and LoveJunk's fridge disposal guide.
// Items marked `est` had no published figure and are set by comparison with similar items.
const PRICE_GUIDE = [
  {
    group: 'Furniture',
    items: [
      { id: 'chair', label: 'Chair, bedside table or small unit', price: [30, 50] },
      { id: 'armchair', label: 'Armchair, chest of drawers or desk', price: [45, 80] },
      { id: 'table', label: 'Dining or coffee table', price: [40, 70], est: true },
      { id: 'sofa', label: 'Sofa (2–3 seater)', price: [60, 120] },
      { id: 'sofa-large', label: 'Corner or large sofa', price: [70, 130] },
      { id: 'mattress', label: 'Mattress', price: [40, 70] },
      { id: 'bed', label: 'Bed frame', price: [70, 130] },
      { id: 'wardrobe', label: 'Wardrobe', price: [70, 130] },
    ],
  },
  {
    group: 'Appliances',
    items: [
      { id: 'fridge', label: 'Fridge or freezer', price: [40, 115] },
      { id: 'fridge-american', label: 'American fridge freezer', price: [80, 130], est: true },
      { id: 'cooker', label: 'Cooker or oven', price: [35, 70], est: true },
      { id: 'washer', label: 'Washing machine, dryer or dishwasher', price: [35, 70], est: true },
      { id: 'tv', label: 'TV or small electrical', price: [20, 40], est: true },
    ],
  },
  {
    group: 'Bags and loads',
    items: [
      { id: 'bag', label: 'Bin bag of rubbish or garden waste', price: [5, 10] },
      { id: 'van-quarter', label: 'Quarter van load', price: [90, 150] },
      { id: 'van-half', label: 'Half van load', price: [150, 250] },
      { id: 'van-three-quarter', label: 'Three-quarter van load', price: [220, 340] },
      { id: 'van-full', label: 'Full van load', price: [250, 400] },
    ],
  },
  {
    group: 'Clearances',
    items: [
      { id: 'garden-small', label: 'Garden clearance, small', price: [150, 300] },
      { id: 'garden-medium', label: 'Garden clearance, medium', price: [300, 600] },
      { id: 'garden-large', label: 'Garden clearance, large or overgrown', price: [600, 2000] },
      { id: 'shed-small', label: 'Shed removal, small (up to 6×4 ft)', price: [150, 250] },
      { id: 'shed-medium', label: 'Shed removal, medium (up to 8×10 ft)', price: [220, 350] },
      { id: 'shed-large', label: 'Shed removal, large (10×12 ft and up)', price: [300, 400] },
      { id: 'shed-concrete', label: 'Concrete panel shed or garage', price: [350, 600] },
      { id: 'room', label: 'Single room, loft or garage clearance', price: [150, 350] },
      { id: 'house-1', label: 'House clearance, 1 bed', price: [250, 450] },
      { id: 'house-2', label: 'House clearance, 2 bed', price: [350, 700] },
      { id: 'house-3', label: 'House clearance, 3 bed', price: [600, 1200] },
      { id: 'house-4', label: 'House clearance, 4 bed or more', price: [1000, 2000] },
    ],
  },
];

// Several items go in one trip, so after the dearest single item the rest cost less.
const EXTRA_ITEM_SHARE = 0.75;
const BULK_GROUPS = new Set(['Bags and loads', 'Clearances']);
const MIN_JOB = [30, 50];

const ITEMS = new Map(PRICE_GUIDE.flatMap((g) => g.items.map((i) => [i.id, { ...i, group: g.group }])));
const round5 = (n) => Math.round(n / 5) * 5;

// counts: { itemId: quantity }. Returns the typical range in pounds, or null when nothing is picked.
function estimate(counts) {
  const singles = [];
  let low = 0, high = 0;
  for (const [id, n] of Object.entries(counts || {})) {
    const item = ITEMS.get(id);
    const qty = Math.max(0, Math.min(99, Math.floor(Number(n) || 0)));
    if (!item || !qty) continue;
    if (BULK_GROUPS.has(item.group)) { low += item.price[0] * qty; high += item.price[1] * qty; }
    else for (let i = 0; i < qty; i++) singles.push(item.price);
  }
  singles.sort((a, b) => b[1] - a[1]).forEach(([l, h], i) => {
    const share = i === 0 ? 1 : EXTRA_ITEM_SHARE;
    low += l * share; high += h * share;
  });
  if (!low && !high) return null;
  return { low: Math.max(MIN_JOB[0], round5(low)), high: Math.max(MIN_JOB[1], round5(high)) };
}

module.exports = { PRICE_GUIDE, EXTRA_ITEM_SHARE, MIN_JOB, estimate };

const pounds = (n) => `£${n.toLocaleString('en-GB')}`;
const rangeText = (id) => { const i = ITEMS.get(id); return `${pounds(i.price[0])}–${pounds(i.price[1])}`; };
const labelOf = (id) => ITEMS.get(id).label;

// The rows shown in the price tables on the front pages.
const HEADLINE = ['chair', 'sofa', 'mattress', 'fridge', 'cooker', 'washer', 'bag', 'van-half', 'van-full',
  'garden-small', 'garden-medium', 'shed-medium', 'room', 'house-2', 'house-3'];

// The rows shown on each service page.
const FOR_SERVICE = {
  'sofa-removal': ['sofa', 'sofa-large', 'armchair'],
  'mattress-removal': ['mattress', 'bed'],
  'fridge-freezer-removal': ['fridge', 'fridge-american', 'cooker', 'washer'],
  'garden-waste-removal': ['bag', 'garden-small', 'garden-medium', 'garden-large', 'shed-small', 'shed-medium'],
  'house-clearance': ['room', 'house-1', 'house-2', 'house-3', 'house-4'],
  'builders-waste-removal': ['van-quarter', 'van-half', 'van-three-quarter', 'van-full'],
};

const SOURCE_NOTE = 'Regular prices for the same job with other UK waste companies, from published price guides (Fantastic Services, LoveJunk), October 2026.';

module.exports.rangeText = rangeText;
module.exports.labelOf = labelOf;
module.exports.HEADLINE = HEADLINE;
module.exports.FOR_SERVICE = FOR_SERVICE;
module.exports.SOURCE_NOTE = SOURCE_NOTE;
module.exports.BULK_GROUPS = [...BULK_GROUPS];
