(() => {
  const $main = document.getElementById('main');
  const $nav = document.getElementById('nav');
  const state = { user: null, config: { categories: [], maxImages: 4, paymentMode: 'off' } };
  let pollTimer = null;
  let tickTimer = null;

  // ---------- helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  const money = (c) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(c / 100);
  const img = (name) => `/uploads/${encodeURIComponent(name)}`;
  const ICONS = { Plastic: '🧴', Metal: '🔩', Paper: '📦', Glass: '🍾', 'E-waste': '🔌', Organic: '🌱', Textile: '👕', Wood: '🪵' };
  const skeletons = (n) => Array.from({ length: n }, () => h('div', { class: 'card skel' }, h('div', { class: 'photo' }), h('div', { class: 'body' }, h('div', { class: 'line' }), h('div', { class: 'line short' }))));
  const kg = (n) => `${Number(n).toLocaleString()} kg`;

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
    return data;
  }

  function toast(msg, bad) {
    const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), text: msg });
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), 4500);
  }

  function timeLeft(endsAt) {
    const s = Math.floor((endsAt - Date.now()) / 1000);
    if (s <= 0) return 'Ended';
    const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${hr}h left`;
    if (hr) return `${hr}h ${m}m left`;
    return `${m}m ${s % 60}s left`;
  }
  function timer(endsAt, cls) {
    const el = h('span', { class: cls, 'data-ends': endsAt });
    refreshTimer(el);
    return el;
  }
  function refreshTimer(el) {
    const ends = Number(el.dataset.ends);
    el.textContent = timeLeft(ends);
    el.classList.toggle('urgent', ends - Date.now() < 3600_000);
  }

  function stopTimers() { clearInterval(pollTimer); pollTimer = null; }

  // ---------- nav ----------
  function renderNav() {
    const route = location.hash || '#/';
    const link = (href, text, cls) => h('a', { href, text, class: (cls || '') + (route === href ? ' active' : '') });
    $nav.replaceChildren(
      link('#/', 'Browse'),
      ...(state.user ? [
        link('#/dashboard', 'My activity'),
        link('#/post', 'Sell waste', 'nav-cta'),
        h('button', { class: 'link', text: `Log out (${state.user.name.split(' ')[0]})`, onclick: logout }),
      ] : [
        link('#/login', 'Log in'),
        link('#/register', 'Sign up', 'nav-cta'),
      ]));
  }
  async function logout() {
    await api('POST', '/api/auth/logout');
    state.user = null;
    renderNav();
    location.hash = '#/';
    toast('Logged out');
  }

  // ---------- views ----------
  function card(l) {
    return h('a', { class: 'card', href: `#/listing/${l.id}` },
      h('div', { class: 'photo' },
        l.images[0] ? h('img', { src: img(l.images[0]), alt: l.title, loading: 'lazy' }) : h('span', { class: 'ph', text: ICONS[l.category] || '♻' }),
        h('span', { class: 'badge', text: `${ICONS[l.category] || ''} ${l.category}` }),
        timer(l.endsAt, 'time')),
      h('div', { class: 'body' },
        h('h3', { text: l.title }),
        h('div', { class: 'muted', text: `${kg(l.qtyKg)} · ${l.location}` }),
        h('div', { class: 'price-row' },
          h('div', {}, h('div', { class: 'tiny', text: l.bidCount ? 'Current bid' : 'Starting at' }), h('span', { class: 'price', text: money(l.currentBidCents) })),
          h('span', { class: 'bidchip' + (l.bidCount ? ' hot' : ''), text: l.bidCount ? `🔥 ${l.bidCount} bid${l.bidCount === 1 ? '' : 's'}` : 'Be first' }))));
  }

  async function viewHome() {
    const filters = { category: 'all', search: '', sort: 'ending' };
    const grid = h('div', { class: 'grid' }, ...skeletons(6));
    const stats = h('div', { class: 'stats' });
    let reqId = 0;

    async function load() {
      const my = ++reqId;
      const p = new URLSearchParams(filters);
      try {
        const { listings } = await api('GET', `/api/listings?${p}`);
        if (my !== reqId) return;
        grid.replaceChildren(...(listings.length
          ? listings.map(card)
          : [h('div', { class: 'empty' },
              h('h3', { text: 'No live auctions match' }),
              h('p', { text: 'Try another category, or list your own waste.' }),
              h('a', { class: 'btn', href: state.user ? '#/post' : '#/register', text: 'Sell waste' }))]));
      } catch (e) { toast(e.message, true); }
    }

    const chips = h('div', { class: 'chips' });
    function drawChips() {
      chips.replaceChildren(...['all', ...state.config.categories].map((c) =>
        h('button', {
          class: 'chip', 'aria-pressed': String(filters.category === c), text: c === 'all' ? 'All' : c,
          onclick: () => { filters.category = c; drawChips(); load(); },
        })));
    }
    drawChips();

    let debounce;
    const search = h('input', {
      type: 'search', placeholder: 'Search materials, places…', 'aria-label': 'Search listings',
      oninput: (e) => { clearTimeout(debounce); debounce = setTimeout(() => { filters.search = e.target.value; load(); }, 250); },
    });
    const sort = h('select', { 'aria-label': 'Sort', onchange: (e) => { filters.sort = e.target.value; load(); } },
      ...[['ending', 'Ending soonest'], ['newest', 'Newest'], ['priceLow', 'Price: low to high'], ['priceHigh', 'Price: high to low'], ['popular', 'Most bids']]
        .map(([v, t]) => h('option', { value: v, text: t })));

    const tiles = h('div', { class: 'tiles' }, ...state.config.categories.map((c) =>
      h('button', { class: 'tile', type: 'button', onclick: () => { filters.category = c; drawChips(); load(); document.getElementById('browse').scrollIntoView(); } },
        h('span', { class: 'ico', text: ICONS[c] || '♻' }), h('span', { text: c }))));
    const feature = (ico, title, text) => h('div', { class: 'feature' }, h('div', { class: 'ico', text: ico }), h('h3', { text: title }), h('p', { class: 'muted', text }));

    $main.replaceChildren(
      h('section', { class: 'hero' },
        h('div', { class: 'hero-copy' },
          h('span', { class: 'eyebrow', text: '♻ The marketplace for recyclables' }),
          h('h1', {}, 'Turn your waste into ', h('span', { class: 'hl', text: 'cash' }), '.'),
          h('p', { text: 'List plastics, metals, paper and more with photos. Collectors compete in live auctions, and the winner pays securely online.' }),
          h('div', { class: 'actions' },
            h('a', { class: 'btn accent lg', href: state.user ? '#/post' : '#/register', text: 'Start selling — it’s free' }),
            h('button', { class: 'btn ghost lg', type: 'button', text: 'Browse auctions', onclick: () => document.getElementById('browse').scrollIntoView() })),
          h('ul', { class: 'trust' }, h('li', { text: '🔒 Card payments by Stripe' }), h('li', { text: '⏱ Anti-sniping auctions' }), h('li', { text: '📸 Photo listings' }))),
        h('img', { class: 'hero-art', src: '/hero.svg', alt: '' })),
      stats,
      h('section', { class: 'block' },
        h('h2', { text: 'Shop by material' }), tiles),
      h('section', { class: 'block' },
        h('h2', { text: 'How it works' }),
        h('div', { class: 'steps' },
          h('div', { class: 'step' }, h('div', { class: 'n', text: '1' }), h('h3', { text: 'Post with photos' }), h('p', { class: 'muted', text: 'Describe the material, add up to 4 photos and choose how long the auction runs.' })),
          h('div', { class: 'step' }, h('div', { class: 'n', text: '2' }), h('h3', { text: 'Collectors bid' }), h('p', { class: 'muted', text: 'Bids update live. Late bids extend the clock so you always get the best price.' })),
          h('div', { class: 'step' }, h('div', { class: 'n', text: '3' }), h('h3', { text: 'Winner pays' }), h('p', { class: 'muted', text: 'The highest bidder pays by card through Stripe, then arranges pickup with you.' })))),
      h('section', { class: 'block', id: 'browse-wrap' },
        h('h2', { id: 'browse', text: 'Live auctions' }),
        h('div', { class: 'toolbar' }, search, sort),
        chips, grid),
      h('section', { class: 'block' },
        h('div', { class: 'features' },
          feature('🌍', 'Keep it out of landfill', 'Materials go to people who will actually reuse and recycle them.'),
          feature('💷', 'Get paid what it’s worth', 'Competitive bidding finds the real market price for your waste.'),
          feature('🛡', 'Safe by design', 'Hashed passwords, verified uploads and payments handled entirely by Stripe.'))),
      h('section', { class: 'cta' },
        h('div', {}, h('h2', { text: 'Got waste worth something?' }), h('p', { text: 'List it in two minutes and let the bids roll in.' })),
        h('a', { class: 'btn accent lg', href: state.user ? '#/post' : '#/register', text: state.user ? 'Post a listing' : 'Create free account' })));

    api('GET', '/api/stats').then((s) => {
      stats.replaceChildren(
        ...[[s.listings, 'Listings posted'], [kg(s.kg), 'Material listed'], [money(s.tradedCents), 'Traded'], [s.users, 'Members']]
          .map(([v, t]) => h('div', { class: 'stat' }, h('b', { text: String(v) }), h('span', { text: t }))));
    }).catch(() => {});
    await load();
    pollTimer = setInterval(load, 20000);
  }

  function authView(mode) {
    const reg = mode === 'register';
    const err = h('div', { class: 'err', role: 'alert' });
    const f = h('form', { class: 'panel narrow', novalidate: true },
      h('h2', { text: reg ? 'Create your account' : 'Welcome back' }),
      reg && h('label', {}, 'Name', h('input', { name: 'name', autocomplete: 'name', required: true })),
      h('label', {}, 'Email', h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true })),
      h('label', {}, 'Password', h('input', { name: 'password', type: 'password', autocomplete: reg ? 'new-password' : 'current-password', required: true, minlength: 8 }),
        reg && h('span', { class: 'hint', text: 'At least 8 characters' })),
      err,
      h('button', { class: 'btn block', type: 'submit', text: reg ? 'Sign up' : 'Log in' }),
      h('p', { class: 'muted' }, reg ? 'Already a member? ' : 'New here? ',
        h('a', { href: reg ? '#/login' : '#/register', text: reg ? 'Log in' : 'Create an account' })));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const d = Object.fromEntries(new FormData(f));
        const { user } = await api('POST', `/api/auth/${reg ? 'register' : 'login'}`, d);
        state.user = user;
        renderNav();
        toast(`Welcome, ${user.name.split(' ')[0]}!`);
        location.hash = sessionStorageGet('next') || '#/';
        sessionStorageSet('next', '');
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    $main.replaceChildren(f);
    f.querySelector('input').focus();
  }
  function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
  function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

  function requireLogin() {
    if (state.user) return true;
    sessionStorageSet('next', location.hash);
    location.hash = '#/login';
    toast('Please log in to continue');
    return false;
  }

  function viewPost() {
    if (!requireLogin()) return;
    let files = [];
    const err = h('div', { class: 'err', role: 'alert' });
    const previews = h('div', { class: 'previews' });
    const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, hidden: true });

    function addFiles(list) {
      for (const f of list) {
        if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { toast(`${f.name}: use JPEG, PNG or WebP`, true); continue; }
        if (f.size > 5 * 1024 * 1024) { toast(`${f.name} is over 5 MB`, true); continue; }
        if (files.length >= state.config.maxImages) { toast(`Up to ${state.config.maxImages} photos`, true); break; }
        files.push(f);
      }
      drawPreviews();
    }
    function drawPreviews() {
      previews.replaceChildren(...files.map((f, i) => h('div', {},
        h('img', { src: URL.createObjectURL(f), alt: `Photo ${i + 1}` }),
        h('button', { type: 'button', 'aria-label': `Remove photo ${i + 1}`, text: '×', onclick: () => { files.splice(i, 1); drawPreviews(); } }))));
    }
    const drop = h('div', { class: 'drop', tabindex: '0', role: 'button', 'aria-label': 'Add photos' },
      h('strong', { text: 'Click or drag photos here' }),
      h('div', { class: 'hint', text: `Up to ${state.config.maxImages} photos · JPEG, PNG or WebP · 5 MB each` }));
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

    const f = h('form', { class: 'panel narrow', novalidate: true },
      h('h2', { text: 'List your waste' }),
      h('div', { class: 'form-grid' },
        h('label', { class: 'full' }, 'Title', h('input', { name: 'title', maxlength: 80, required: true, placeholder: 'e.g. Rinsed PET bottles, baled' })),
        h('label', {}, 'Category', h('select', { name: 'category' }, ...state.config.categories.map((c) => h('option', { text: c })))),
        h('label', {}, 'Quantity (kg)', h('input', { name: 'qtyKg', type: 'number', min: 1, step: 'any', required: true })),
        h('label', {}, 'Starting price (USD)', h('input', { name: 'startPrice', type: 'number', min: 1, step: '0.01', required: true })),
        h('label', {}, 'Auction length', h('select', { name: 'durationHours' },
          ...[[24, '1 day'], [72, '3 days'], [168, '7 days'], [336, '14 days']].map(([v, t]) => h('option', { value: v, text: t, selected: v === 168 })))),
        h('label', { class: 'full' }, 'Pickup location', h('input', { name: 'location', maxlength: 100, required: true, placeholder: 'City or postcode' })),
        h('label', { class: 'full' }, 'Description', h('textarea', { name: 'description', maxlength: 2000, required: true, placeholder: 'Condition, how it is stored, access for pickup…' })),
        h('div', { class: 'full' }, h('strong', { text: 'Photos' }), drop, input, previews)),
      err,
      h('button', { class: 'btn block', type: 'submit', text: 'Publish listing' }));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!files.length) { err.textContent = 'Add at least one photo'; return; }
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Uploading…';
      const fd = new FormData(f);
      files.forEach((file) => fd.append('images', file));
      try {
        const { id } = await api('POST', '/api/listings', fd);
        toast('Your listing is live!');
        location.hash = `#/listing/${id}`;
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Publish listing'; }
    });
    $main.replaceChildren(f);
  }

  async function viewListing(id, query) {
    $main.replaceChildren(h('div', { class: 'loading', text: 'Loading…' }));
    let selected = 0;
    let offset = 0;
    let data;

    async function fetchData() {
      const r = await api('GET', `/api/listings/${id}`);
      data = r.listing;
      offset = r.serverTime - Date.now();
    }

    function draw() {
      const l = data;
      const main = h('div', { class: 'main-photo' }, l.images[selected] && h('img', { src: img(l.images[selected]), alt: l.title }));
      const thumbs = l.images.length > 1 && h('div', { class: 'thumbs' }, ...l.images.map((n, i) =>
        h('button', { type: 'button', 'aria-label': `Photo ${i + 1}`, 'aria-current': String(i === selected), onclick: () => { selected = i; draw(); } },
          h('img', { src: img(n), alt: '' }))));

      const panel = h('div', { class: 'panel sticky' });
      const open = l.status === 'open';
      panel.append(
        h('div', {}, h('div', { class: 'muted', text: open ? 'Current bid' : l.bidCount ? 'Winning bid' : 'No bids' }),
          h('div', { class: 'big-price', text: money(l.winningBidCents || l.currentBidCents) })),
        h('div', { class: 'meta' },
          h('div', {}, 'Time left', open ? timer(l.endsAt, 'tl') : h('b', { text: 'Ended' })),
          h('div', {}, 'Bids', h('b', { text: String(l.bidCount) })),
          h('div', {}, 'Quantity', h('b', { text: kg(l.qtyKg) })),
          h('div', {}, 'Pickup', h('b', { text: l.location }))));

      if (open) {
        if (l.isSeller) panel.append(h('div', { class: 'notice', text: 'This is your listing. You can’t bid on it.' }));
        else {
          const err = h('div', { class: 'err', role: 'alert' });
          const amount = h('input', { type: 'number', step: '0.01', min: l.minNextBidCents / 100, value: (l.minNextBidCents / 100).toFixed(2), 'aria-label': 'Bid amount in USD' });
          const form = h('form', { novalidate: true },
            h('div', { class: 'bid-row' }, amount, h('button', { class: 'btn', type: 'submit', text: 'Place bid' })),
            h('div', { class: 'hint', text: `Minimum ${money(l.minNextBidCents)}` }));
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!requireLogin()) return;
            err.textContent = '';
            try {
              await api('POST', `/api/listings/${id}/bids`, { amount: Number(amount.value) });
              toast('Bid placed — you’re in the lead!');
              await fetchData(); draw();
            } catch (ex) {
              if (ex.status === 409) { await fetchData(); draw(); toast(ex.message, true); } else err.textContent = ex.message;
            }
          });
          panel.append(form, err);
        }
      } else if (l.status === 'closed') {
        if (l.isWinner) panel.append(payBlock(l));
        else if (l.isSeller) panel.append(h('div', { class: 'notice', text: `Sold to ${l.winnerName} for ${money(l.winningBidCents)}. Waiting for payment.` }));
        else panel.append(h('div', { class: 'notice warn', text: 'This auction has ended.' }));
      } else if (l.status === 'paid') {
        panel.append(h('div', { class: 'notice', text: l.isWinner ? 'Paid — thank you! Contact the seller to arrange pickup.' : l.isSeller ? `Paid by ${l.winnerName}. Arrange pickup with the buyer.` : 'This item has been sold.' }));
      } else panel.append(h('div', { class: 'notice warn', text: 'This auction ended with no bids.' }));

      panel.append(h('div', {}, h('strong', { text: 'Bid history' }),
        l.bids.length ? h('ul', { class: 'bids' }, ...l.bids.map((b) => h('li', {}, h('span', { text: b.bidder }), h('span', { text: money(b.amountCents) }))))
          : h('p', { class: 'muted', text: 'No bids yet. Be the first!' })));

      $main.replaceChildren(
        h('p', {}, h('a', { href: '#/', text: '← All auctions' })),
        h('div', { class: 'detail' },
          h('div', {},
            h('div', { class: 'gallery' }, main, thumbs),
            h('h1', { text: l.title }),
            h('p', { class: 'muted', text: `${l.category} · Listed by ${l.sellerName}` }),
            h('p', { text: l.description, class: 'desc' })),
          panel));
    }

    function payBlock(l) {
      const mode = state.config.paymentMode;
      const err = h('div', { class: 'err', role: 'alert' });
      const btn = h('button', { class: 'btn accent block', text: `Pay ${money(l.winningBidCents)}${mode === 'demo' ? ' (demo)' : ''}` });
      btn.addEventListener('click', async () => {
        btn.disabled = true; err.textContent = '';
        try {
          const r = await api('POST', `/api/listings/${id}/checkout`);
          if (r.url) location.href = r.url;
          else { toast('Payment recorded (demo)'); await fetchData(); draw(); }
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      });
      return h('div', { class: 'panel' },
        h('div', { class: 'notice', text: '🎉 You won this auction!' }),
        mode === 'off' ? h('div', { class: 'notice warn', text: 'Online payment is not enabled yet. The seller will contact you.' }) : btn,
        err, h('div', { class: 'hint', text: 'Secure card payment by Stripe. We never see your card details.' }));
    }

    try {
      if (query.get('paid')) {
        if (requireLogin()) {
          const r = await api('POST', `/api/listings/${id}/verify-payment`).catch(() => null);
          if (r && r.status === 'paid') toast('Payment received — thank you!');
          history.replaceState(null, '', `#/listing/${id}`);
        }
      }
      await fetchData();
    } catch (e) {
      $main.replaceChildren(h('div', { class: 'empty' }, h('h2', { text: e.status === 404 ? 'Listing not found' : 'Could not load listing' }), h('a', { class: 'btn', href: '#/', text: 'Back to auctions' })));
      return;
    }
    draw();
    document.title = `${data.title} · Waste Warrior`;
    pollTimer = setInterval(async () => {
      if (document.hidden || document.activeElement?.tagName === 'INPUT') return;
      try { await fetchData(); draw(); } catch { /* ignore */ }
    }, 6000);
  }

  async function viewDashboard() {
    if (!requireLogin()) return;
    $main.replaceChildren(h('div', { class: 'loading', text: 'Loading…' }));
    let act;
    try { act = await api('GET', '/api/me/activity'); } catch (e) { toast(e.message, true); return; }
    let tab = 'bidding';
    const body = h('div');
    const row = (l, pill) => h('a', { class: 'row', href: `#/listing/${l.id}` },
      l.images[0] ? h('img', { src: img(l.images[0]), alt: '' }) : h('span'),
      h('div', { class: 'grow' }, h('b', { text: l.title }), h('span', { class: 'muted', text: `${money(l.currentBidCents)} · ${l.bidCount} bid${l.bidCount === 1 ? '' : 's'}` })),
      pill);
    const statusPill = (l) => ({
      open: h('span', { class: 'pill' }, timer(l.endsAt, '')),
      closed: h('span', { class: 'pill warn', text: 'Awaiting payment' }),
      paid: h('span', { class: 'pill', text: 'Paid' }),
      expired: h('span', { class: 'pill bad', text: 'No bids' }),
    })[l.status];
    function draw() {
      const list = tab === 'bidding' ? act.bidding : act.selling;
      body.replaceChildren(...(list.length ? list.map((l) => row(l,
        tab === 'bidding'
          ? (l.status === 'open' ? h('span', { class: 'pill' + (l.leading ? '' : ' bad'), text: l.leading ? 'Leading' : 'Outbid' })
            : l.isWinner ? h('span', { class: 'pill warn', text: l.status === 'paid' ? 'Won · paid' : 'Won · pay now' }) : h('span', { class: 'pill bad', text: 'Lost' }))
          : statusPill(l)))
        : [h('div', { class: 'empty' }, h('p', { text: tab === 'bidding' ? 'You haven’t placed any bids yet.' : 'You haven’t listed anything yet.' }),
            h('a', { class: 'btn', href: tab === 'bidding' ? '#/' : '#/post', text: tab === 'bidding' ? 'Browse auctions' : 'Sell waste' }))]));
      tabs.replaceChildren(
        h('button', { class: 'chip', 'aria-pressed': String(tab === 'bidding'), text: `My bids (${act.bidding.length})`, onclick: () => { tab = 'bidding'; draw(); } }),
        h('button', { class: 'chip', 'aria-pressed': String(tab === 'selling'), text: `My listings (${act.selling.length})`, onclick: () => { tab = 'selling'; draw(); } }));
    }
    const tabs = h('div', { class: 'tabs' });
    $main.replaceChildren(h('h1', { text: 'My activity' }), tabs, body);
    draw();
  }

  // ---------- router ----------
  async function route() {
    stopTimers();
    document.title = 'Waste Warrior Bidding';
    renderNav();
    const [path, qs] = (location.hash.slice(1) || '/').split('?');
    const query = new URLSearchParams(qs || '');
    window.scrollTo(0, 0);
    if (path === '/' || path === '') return viewHome();
    if (path === '/login') return state.user ? (location.hash = '#/') : authView('login');
    if (path === '/register') return state.user ? (location.hash = '#/') : authView('register');
    if (path === '/post') return viewPost();
    if (path === '/dashboard') return viewDashboard();
    const m = path.match(/^\/listing\/(\d+)$/);
    if (m) return viewListing(m[1], query);
    $main.replaceChildren(h('div', { class: 'empty' }, h('h2', { text: 'Page not found' }), h('a', { class: 'btn', href: '#/', text: 'Go home' })));
  }

  // keep all countdowns ticking
  tickTimer = setInterval(() => document.querySelectorAll('[data-ends]').forEach(refreshTimer), 1000);

  window.addEventListener('hashchange', route);
  document.getElementById('year').textContent = new Date().getFullYear();
  (async () => {
    try {
      const [cfg, me] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/me')]);
      state.config = cfg; state.user = me.user;
    } catch { toast('Could not reach the server', true); }
    route();
  })();
})();
