const KEY = 'wwb-listings';
const seed = [
  { id: 1, title: 'Clean PET bottles', category: 'Plastic', qty: 200, price: 40, bids: 2 },
  { id: 2, title: 'Aluminium offcuts', category: 'Metal', qty: 80, price: 90, bids: 1 },
  { id: 3, title: 'Cardboard bales', category: 'Paper', qty: 500, price: 55, bids: 0 },
];

const load = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) || seed; } catch { return seed; }
};
const save = (l) => { try { localStorage.setItem(KEY, JSON.stringify(l)); } catch {} };

let listings = load();
const grid = document.getElementById('listing-grid');
const filter = document.getElementById('filter');

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  kids.forEach((k) => n.append(k));
  return n;
}

function render() {
  grid.replaceChildren();
  const shown = listings.filter((l) => filter.value === 'all' || l.category === filter.value);
  if (!shown.length) grid.append(el('p', { textContent: 'No listings yet.' }));
  shown.forEach((l) => {
    const err = el('div', { className: 'error' });
    const input = el('input', { type: 'number', min: l.price + 0.01, step: '0.01', placeholder: 'Your bid', required: true });
    const form = el('form', { className: 'bid-form' }, input, el('button', { className: 'btn', textContent: 'Bid' }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = parseFloat(input.value);
      if (!(v > l.price)) { err.textContent = `Bid must exceed $${l.price.toFixed(2)}`; return; }
      l.price = v; l.bids += 1;
      save(listings); render();
    });
    grid.append(el('div', { className: 'card' },
      el('span', { className: 'tag', textContent: l.category }),
      el('h3', { textContent: l.title }),
      el('p', { textContent: `${l.qty} kg · ${l.bids} bid${l.bids === 1 ? '' : 's'}` }),
      el('div', { className: 'price', textContent: `$${l.price.toFixed(2)}` }),
      form, err));
  });
}

document.getElementById('post-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  listings.unshift({
    id: Date.now(), title: f.get('title').trim(), category: f.get('category'),
    qty: +f.get('qty'), price: +f.get('price'), bids: 0,
  });
  save(listings); e.target.reset(); filter.value = 'all'; render();
  location.hash = 'listings';
});

filter.addEventListener('change', render);
document.getElementById('year').textContent = new Date().getFullYear();
render();
