(() => {
  const $main = document.getElementById('main');
  const $nav = document.getElementById('nav');
  const state = { user: null, config: { categories: [], loadSizes: [], maxImages: 4, paymentMode: 'off', feePercent: 10, plus: { available: false, feePercent: 6, pricePence: 295 }, pro: { available: false, feePercent: 6, pricePence: 499 } } };
  const isPlus = () => Boolean(state.user && state.user.plus && state.user.plus.active);
  const isPro = () => Boolean(state.user && state.user.pro && state.user.pro.active);
  const myFee = () => (isPlus() ? state.config.plus.feePercent : state.config.feePercent);
  const myHaulerFee = () => (isPro() ? state.config.pro.feePercent : state.config.feePercent);
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
  const money = (c) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(c / 100);
  const img = (name) => `/uploads/${encodeURIComponent(name)}`;
  const ICONS = { Household: '🏠', Garden: '🌿', Furniture: '🛋', Appliances: '🧊', 'Building rubble': '🧱', 'Mixed recycling': '♻', Commercial: '🏢' };
  const skeletons = (n) => Array.from({ length: n }, () => h('div', { class: 'card skel' }, h('div', { class: 'photo' }), h('div', { class: 'body' }, h('div', { class: 'line' }), h('div', { class: 'line short' }))));
  const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const when = (l) => (!l.collectFrom ? '' : l.collectFrom === l.collectBy ? fmtDay(l.collectFrom) : `${fmtDay(l.collectFrom)} – ${fmtDay(l.collectBy)}`);
  const isoDay = (offset) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

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
      link('#/haulers', 'Haulers'),
      link('#/plus', 'Plans'),
      ...(state.user ? [
        link('#/dashboard', 'My activity'),
        link('#/post', 'Post a job', 'nav-cta'),
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
        h('div', { class: 'muted', text: `${l.loadSize} · ${l.location}` }),
        l.collectFrom && h('div', { class: 'muted', text: `📅 ${when(l)}` }),
        h('div', { class: 'price-row' },
          h('div', {}, h('div', { class: 'tiny', text: l.bidCount ? 'Lowest bid' : 'Budget up to' }), h('span', { class: 'price', text: money(l.currentBidCents) })),
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
              h('h3', { text: 'No open jobs match' }),
              h('p', { text: 'Try another waste type, or post your own job.' }),
              h('a', { class: 'btn', href: state.user ? '#/post' : '#/register', text: 'Post a job' }))]));
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
      type: 'search', placeholder: 'Search jobs, towns, postcodes…', 'aria-label': 'Search jobs',
      oninput: (e) => { clearTimeout(debounce); debounce = setTimeout(() => { filters.search = e.target.value; load(); }, 250); },
    });
    const sort = h('select', { 'aria-label': 'Sort', onchange: (e) => { filters.sort = e.target.value; load(); } },
      ...[['ending', 'Closing soonest'], ['newest', 'Newest'], ['priceLow', 'Price: low to high'], ['priceHigh', 'Price: high to low'], ['popular', 'Most bids']]
        .map(([v, t]) => h('option', { value: v, text: t })));

    const tiles = h('div', { class: 'tiles' }, ...state.config.categories.map((c) =>
      h('button', { class: 'tile', type: 'button', onclick: () => { filters.category = c; drawChips(); load(); document.getElementById('browse').scrollIntoView(); } },
        h('span', { class: 'ico', text: ICONS[c] || '♻' }), h('span', { text: c }))));
    const feature = (ico, title, text) => h('div', { class: 'feature' }, h('div', { class: 'ico', text: ico }), h('h3', { text: title }), h('p', { class: 'muted', text }));
    const estimates = [
      ['Single chair or fridge', '£30–£200'],
      ['Bathroom rip-out', 'About £250'],
      ['Garden clearance', 'About £400'],
      ['House clearance', 'About £1,000'],
    ];

    $main.replaceChildren(
      h('section', { class: 'hero' },
        h('div', { class: 'hero-copy' },
          h('span', { class: 'eyebrow', text: '♻ Waste removal, priced by competition' }),
          h('h1', {}, 'Get your waste cleared for ', h('span', { class: 'hl', text: 'less' }), '.'),
          h('p', { text: 'Post your job with photos and dates. Local waste removal providers bid against each other to do it, and the lowest price wins.' }),
          h('div', { class: 'actions' },
            h('a', { class: 'btn accent lg', href: state.user ? '#/post' : '#/register', text: 'Post a job' }),
            h('button', { class: 'btn ghost lg', type: 'button', text: 'Find jobs to bid on', onclick: () => document.getElementById('browse').scrollIntoView() })),
          h('ul', { class: 'trust' }, h('li', { text: '🔒 Card payments by Stripe' }), h('li', { text: '📉 Lowest bid wins' }), h('li', { text: '📸 Photo jobs' }))),
        h('img', { class: 'hero-art', src: '/hero.svg', alt: '' })),
      stats,
      h('section', { class: 'block' },
        h('h2', { text: 'Browse by waste type' }), tiles),
      h('section', { class: 'block', 'aria-labelledby': 'estimate-title' },
        h('h2', { id: 'estimate-title', text: 'Rough price guide' }),
        h('p', { class: 'muted estimate-note', text: 'Use these as starting estimates. The final price depends on the amount of waste, access, and collection location.' }),
        h('table', { class: 'estimates' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Job type' }), h('th', { scope: 'col', text: 'Estimated budget' }))),
          h('tbody', {}, ...estimates.map(([job, price]) => h('tr', {}, h('th', { scope: 'row', text: job }), h('td', { text: price }))))),
        h('p', { class: 'hint', text: 'These are rough guides, not guaranteed quotes. Providers compete to offer a lower price.' })),
      h('section', { class: 'block' },
        h('h2', { text: 'How it works' }),
        h('div', { class: 'steps' },
          h('div', { class: 'step' }, h('div', { class: 'n', text: '1' }), h('h3', { text: 'Post your job' }), h('p', { class: 'muted', text: 'Say what needs clearing, how much there is, when it can be collected and how to get to it. Add photos and your maximum budget.' })),
          h('div', { class: 'step' }, h('div', { class: 'n', text: '2' }), h('h3', { text: 'Providers bid it down' }), h('p', { class: 'muted', text: 'Each new bid has to beat the lowest one. Late bids extend the clock so you always get the best price.' })),
          h('div', { class: 'step' }, h('div', { class: 'n', text: '3' }), h('h3', { text: 'Accept and pay' }), h('p', { class: 'muted', text: 'When bidding closes, accept the lowest bid and pay by card. The provider then gets your address and collects on your dates.' })))),
      h('section', { class: 'block', id: 'browse-wrap' },
        h('h2', { id: 'browse', text: 'Open jobs' }),
        h('div', { class: 'toolbar' }, search, sort),
        chips, grid),
      h('section', { class: 'block' },
        h('div', { class: 'features' },
          feature('💷', 'Pay less', 'Providers compete for your job, so the price only goes down.'),
          feature('📍', 'Your address stays private', 'Bidders only see the town or postcode area. The full address goes to the provider you pay.'),
          feature('🛡', 'Safe by design', 'Hashed passwords, verified uploads and payments handled entirely by Stripe.'))),
      h('section', { class: 'cta' },
        h('div', {}, h('h2', { text: 'Got rubbish to shift?' }), h('p', { text: 'Post a job in two minutes and let providers compete for it.' })),
        h('a', { class: 'btn accent lg', href: state.user ? '#/post' : '#/register', text: state.user ? 'Post a job' : 'Create free account' })));

    api('GET', '/api/stats').then((s) => {
      stats.replaceChildren(
        ...[[s.listings, 'Jobs posted'], [s.booked, 'Jobs booked'], [money(s.savedCents), 'Saved vs. budgets'], [s.users, 'Members']]
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
        h('a', { href: reg ? '#/login' : '#/register', text: reg ? 'Log in' : 'Create an account' })),
      !reg && h('p', { class: 'muted' }, h('a', { href: '#/forgot-password', text: 'Forgot your password?' })));
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

  function recoveryView(mode, token = '') {
    const resetting = mode === 'reset';
    const err = h('div', { class: 'err', role: 'alert' });
    const f = h('form', { class: 'panel narrow', novalidate: true },
      h('h2', { text: resetting ? 'Choose a new password' : 'Recover your password' }),
      resetting
        ? [
          h('input', { type: 'hidden', name: 'token', value: token }),
          h('label', {}, 'New password', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 }),
            h('span', { class: 'hint', text: 'At least 8 characters' })),
        ]
        : h('label', {}, 'Email', h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true })),
      err,
      h('button', { class: 'btn block', type: 'submit', text: resetting ? 'Set new password' : 'Email reset link' }),
      h('p', { class: 'muted' }, h('a', { href: '#/login', text: 'Back to log in' })));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const body = Object.fromEntries(new FormData(f));
        const result = await api('POST', resetting ? '/api/auth/reset-password' : '/api/auth/forgot-password', body);
        if (resetting) {
          toast('Password updated. You can now log in.');
          location.hash = '#/login';
        } else {
          f.replaceChildren(
            h('h2', { text: 'Check your email' }),
            h('p', { class: 'muted', text: result.message }),
            h('p', { class: 'muted' }, h('a', { href: '#/login', text: 'Back to log in' })));
        }
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    $main.replaceChildren(f);
    f.querySelector('input:not([type=hidden])').focus();
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
      h('h2', { text: 'Post a waste removal job' }),
      h('div', { class: 'form-grid' },
        h('label', { class: 'full' }, 'What needs clearing?', h('input', { name: 'title', maxlength: 80, required: true, placeholder: 'e.g. Old sofa and 6 bags of garden waste' })),
        h('label', {}, 'Waste type', h('select', { name: 'category' }, ...state.config.categories.map((c) => h('option', { text: c })))),
        h('label', {}, 'How much?', h('select', { name: 'loadSize' }, ...state.config.loadSizes.map((c) => h('option', { text: c, selected: c === 'Half van' }))),
          h('span', { class: 'hint', text: 'A full van is roughly a 4-yard skip' })),
        h('label', {}, 'Collect from', h('input', { name: 'collectFrom', type: 'date', min: isoDay(0), value: isoDay(3), required: true })),
        h('label', {}, 'Collect by', h('input', { name: 'collectBy', type: 'date', min: isoDay(0), value: isoDay(10), required: true })),
        h('label', {}, 'Maximum budget (£)', h('input', { name: 'startPrice', type: 'number', min: 1, step: '0.01', required: true }),
          h('span', { class: 'hint' }, `Bids start here and go down. A ${myFee()}% service fee is added when you pay.`,
            !isPlus() && state.config.plus.available ? [' ', h('a', { href: '#/plus', text: `Pay ${state.config.plus.feePercent}% with Plus` })] : null)),
        h('label', {}, 'Bidding open for', h('select', { name: 'durationHours' },
          ...Array.from({ length: 23 }, (_, i) => i + 1).map((hours) => h('option', { value: hours, text: `${hours} ${hours === 1 ? 'hour' : 'hours'}`, selected: hours === 3 })))),
        h('label', {}, 'Town or postcode area', h('input', { name: 'location', maxlength: 100, required: true, placeholder: 'e.g. Leeds LS6' }),
          h('span', { class: 'hint', text: 'Shown to everyone' })),
        h('label', {}, 'Full address', h('input', { name: 'address', maxlength: 200, required: true, autocomplete: 'street-address', placeholder: 'House number, street, postcode' }),
          h('span', { class: 'hint', text: 'Only shared with the provider you pay' })),
        h('label', { class: 'full' }, 'Access notes', h('textarea', { name: 'accessNotes', maxlength: 500, placeholder: 'e.g. Side gate, 2nd floor with no lift, parking on the street' })),
        h('label', { class: 'full' }, 'Description', h('textarea', { name: 'description', maxlength: 2000, required: true, placeholder: 'What the waste is, roughly how many bags or items, anything heavy or awkward…' })),
        h('div', { class: 'full' }, h('strong', { text: 'Photos' }), drop, input, previews)),
      err,
      h('button', { class: 'btn block', type: 'submit', text: 'Post job' }));
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
        toast('Your job is live!');
        location.hash = `#/listing/${id}`;
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Post job'; }
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
        h('div', {}, h('div', { class: 'muted', text: open ? (l.bidCount ? 'Lowest bid' : 'Customer’s budget') : l.bidCount ? 'Winning bid' : 'No bids' }),
          h('div', { class: 'big-price', text: money(l.winningBidCents || l.currentBidCents) })),
        h('div', { class: 'meta' },
          h('div', {}, 'Bidding', open ? timer(l.endsAt, 'tl') : h('b', { text: 'Closed' })),
          h('div', {}, 'Bids', h('b', { text: String(l.bidCount) })),
          h('div', {}, 'Amount', h('b', { text: l.loadSize })),
          h('div', {}, 'Area', h('b', { text: l.location }))));

      if (open) {
        if (l.isSeller) panel.append(h('div', { class: 'notice', text: 'This is your job. Providers are bidding the price down. When bidding closes you can accept the lowest bid.' }));
        else {
          const err = h('div', { class: 'err', role: 'alert' });
          const amount = h('input', { type: 'number', step: '0.01', min: 1, max: l.maxNextBidCents / 100, value: (l.maxNextBidCents / 100).toFixed(2), 'aria-label': 'Your price in pounds' });
          const form = h('form', { novalidate: true },
            h('div', { class: 'bid-row' }, amount, h('button', { class: 'btn', type: 'submit', text: 'Place bid' })),
            h('div', { class: 'hint' }, `Your price for the whole job. Must be ${money(l.maxNextBidCents)} or less. You receive ${100 - myHaulerFee()}% of your bid after our ${myHaulerFee()}% fee.`,
              !isPro() && state.config.pro.available ? [' ', h('a', { href: '#/plus', text: `Keep ${100 - state.config.pro.feePercent}% with Hauler Pro` })] : null));
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!requireLogin()) return;
            err.textContent = '';
            try {
              await api('POST', `/api/listings/${id}/bids`, { amount: Number(amount.value) });
              toast('Bid placed — you’re the lowest!');
              await fetchData(); draw();
            } catch (ex) {
              if (ex.status === 409) { await fetchData(); draw(); toast(ex.message, true); } else err.textContent = ex.message;
            }
          });
          panel.append(form, err);
          if (state.user && !(state.user.carrier && state.user.carrier.verified)) {
            panel.append(h('div', { class: 'notice warn' }, 'Add your waste carrier number so customers can see you’re registered. ',
              h('a', { href: '#/haulers', text: 'Add it now' })));
          }
        }
      } else if (l.status === 'closed') {
        if (l.isSeller) panel.append(acceptBlock(l));
        else if (l.isWinner) panel.append(h('div', { class: 'notice', text: `🎉 You have the lowest bid at ${money(l.winningBidCents)}. Waiting for the customer to accept and pay. You’ll receive ${money(l.providerPayoutCents)} after the ${l.providerFeePercent ?? state.config.feePercent}% fee.` }));
        else panel.append(h('div', { class: 'notice warn', text: 'Bidding on this job has closed.' }));
      } else if (l.status === 'paid') {
        panel.append(l.isWinner || l.isSeller ? bookedBlock(l) : h('div', { class: 'notice', text: 'This job has been booked.' }));
      } else if (l.status === 'cancelled') {
        panel.append(h('div', { class: 'notice warn', text: l.isSeller ? 'You declined the lowest bid. Post the job again any time.' : 'The customer didn’t go ahead with this job.' }));
      } else panel.append(h('div', { class: 'notice warn', text: 'Bidding closed with no bids.' }));

      panel.append(h('div', {}, h('strong', { text: 'Bids (lowest first)' }),
        l.bids.length ? h('ul', { class: 'bids' }, ...l.bids.map((b) => h('li', {},
          h('span', { class: 'bidder' }, h('span', { text: b.bidder }), carrierBadge(b.carrier)),
          h('span', { text: money(b.amountCents) }))))
          : h('p', { class: 'muted', text: 'No bids yet. Be the first!' })));

      const fact = (k, v) => v && h('div', {}, h('dt', { text: k }), h('dd', { text: v }));
      $main.replaceChildren(
        h('p', {}, h('a', { href: '#/', text: '← All jobs' })),
        h('div', { class: 'detail' },
          h('div', {},
            h('div', { class: 'gallery' }, main, thumbs),
            h('h1', { text: l.title }),
            h('p', { class: 'muted', text: `${ICONS[l.category] || ''} ${l.category} · Posted by ${l.sellerName}` }),
            h('dl', { class: 'facts' },
              fact('Collection dates', when(l)),
              fact('Amount', l.loadSize),
              fact('Area', l.location),
              fact('Access', l.accessNotes),
              l.address && fact(l.isSeller ? 'Address (private)' : 'Address', l.address)),
            h('p', { text: l.description, class: 'desc' })),
          panel));
    }

    function acceptBlock(l) {
      const mode = state.config.paymentMode;
      const err = h('div', { class: 'err', role: 'alert' });
      const btn = h('button', { class: 'btn accent block', text: `Accept and pay ${money(l.customerTotalCents)}${mode === 'demo' ? ' (demo)' : ''}` });
      btn.addEventListener('click', async () => {
        btn.disabled = true; err.textContent = '';
        try {
          const r = await api('POST', `/api/listings/${id}/checkout`);
          if (r.url) location.href = r.url;
          else { toast('Job booked (demo payment)'); await fetchData(); draw(); }
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      });
      const decline = h('button', { class: 'btn secondary block', text: 'Don’t go ahead' });
      decline.addEventListener('click', async () => {
        if (!confirm('Decline this bid? The job will be closed.')) return;
        decline.disabled = true; err.textContent = '';
        try { await api('POST', `/api/listings/${id}/decline`); await fetchData(); draw(); } catch (ex) { err.textContent = ex.message; decline.disabled = false; }
      });
      return h('div', { class: 'panel' },
        h('div', { class: 'notice', text: `Bidding has closed. ${l.winnerName} offered the lowest price: ${money(l.winningBidCents)}.` }),
        h('dl', { class: 'facts' },
          h('div', {}, h('dt', { text: 'Winning bid' }), h('dd', { text: money(l.winningBidCents) })),
          h('div', {}, h('dt', { text: `Service fee (${l.customerFeePercent ?? state.config.feePercent}%${l.customerFeePercent < state.config.feePercent ? ', Plus' : ''})` }), h('dd', { text: money(l.customerFeeCents) })),
          h('div', {}, h('dt', { text: 'Total to pay' }), h('dd', { text: money(l.customerTotalCents) }))),
        !isPlus() && state.config.plus.available && h('p', { class: 'hint' }, `Plus members pay a ${state.config.plus.feePercent}% fee instead of ${state.config.feePercent}%. `,
          h('a', { href: '#/plus', text: 'See Plus' })),
        mode === 'off' ? h('div', { class: 'notice warn', text: 'Online payment is not enabled yet.' }) : btn,
        decline,
        err, h('div', { class: 'hint', text: 'Secure card payment by Stripe. We never see your card details.' }));
    }

    function bookedBlock(l) {
      const c = l.contact || {};
      return h('div', { class: 'panel' },
        h('div', { class: 'notice', text: l.isSeller ? `✅ Booked and paid. ${c.name} will collect between ${when(l)}.` : `✅ Booked for ${money(l.winningBidCents)}. You’ll receive ${money(l.providerPayoutCents)} after the ${l.providerFeePercent ?? state.config.feePercent}% fee. Please collect between ${when(l)}.` }),
        h('dl', { class: 'facts' },
          h('div', {}, h('dt', { text: l.isSeller ? 'Your provider' : 'Customer' }), h('dd', { text: c.name })),
          h('div', {}, h('dt', { text: 'Email' }), h('dd', {}, h('a', { href: `mailto:${c.email}`, text: c.email }))),
          l.isWinner && h('div', {}, h('dt', { text: 'Collection address' }), h('dd', { text: l.address }))));
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
      $main.replaceChildren(h('div', { class: 'empty' }, h('h2', { text: e.status === 404 ? 'Job not found' : 'Could not load job' }), h('a', { class: 'btn', href: '#/', text: 'Back to jobs' })));
      return;
    }
    draw();
    document.title = `${data.title} · Waste Warrior`;
    pollTimer = setInterval(async () => {
      if (document.hidden || document.activeElement?.tagName === 'INPUT') return;
      try { await fetchData(); draw(); } catch { /* ignore */ }
    }, 6000);
  }

  // ---------- monthly plans: Plus (customers) and Hauler Pro (haulers) ----------
  async function viewPlans(query) {
    document.title = 'Plans · Waste Warrior';
    const std = state.config.feePercent;
    const PLAN = {
      plus: { name: 'Plus', full: 'Waste Warrior Plus', for: 'For customers', cfg: state.config.plus },
      pro: { name: 'Hauler Pro', full: 'Hauler Pro', for: 'For haulers', cfg: state.config.pro },
    };
    const sub = query.get('subscribed');
    if (PLAN[sub] && state.user) {
      try {
        const { user } = await api('POST', `/api/${sub}/verify`);
        state.user = user; renderNav();
        if (user[sub] && user[sub].active) toast(`Welcome to ${PLAN[sub].full}! Your lower fee is now active.`);
      } catch { /* the webhook will catch up */ }
      history.replaceState(null, '', '#/plus');
    }
    const fmtUntil = (ms) => (ms ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

    function action(key, err) {
      const P = PLAN[key], c = P.cfg;
      if (!c.available) return h('div', { class: 'notice warn', text: `${P.name} isn’t available just yet. Check back soon.` });
      if (!state.user) return h('a', { class: 'btn accent block', href: '#/register', text: `Sign up and get ${P.name}` });
      const pl = state.user[key];
      if (pl && pl.active) {
        const until = fmtUntil(pl.until);
        const btn = h('button', { class: 'btn secondary block', type: 'button', text: pl.cancelAtEnd ? `Keep ${P.name}` : `Cancel ${P.name}` });
        btn.addEventListener('click', async () => {
          if (!pl.cancelAtEnd && !confirm(`Cancel ${P.name}? You’ll keep the ${c.feePercent}% fee until ${until || 'the end of this month'}.`)) return;
          btn.disabled = true; err.textContent = '';
          try {
            const { user } = await api('POST', `/api/${key}/${pl.cancelAtEnd ? 'resume' : 'cancel'}`);
            state.user = user; renderNav(); draw();
            toast(pl.cancelAtEnd ? `${P.name} will carry on renewing` : `${P.name} cancelled. It stays active until the end of your month.`);
          } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
        });
        return h('div', { class: 'plus-status' },
          h('div', { class: 'notice', text: pl.cancelAtEnd ? `✔ Active until ${until}. It won’t renew.` : `✔ You’re on ${P.name}.${until ? ` Next payment ${until}.` : ''}` }),
          btn);
      }
      const btn = h('button', { class: 'btn accent block', type: 'button', text: `Get ${P.name} for ${money(c.pricePence)}/month` });
      btn.addEventListener('click', async () => {
        btn.disabled = true; err.textContent = '';
        try {
          const r = await api('POST', `/api/${key}/checkout`);
          if (r.url) location.href = r.url;
          else { state.user = r.user; renderNav(); draw(); toast(`${P.name} activated (demo)`); }
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      });
      return btn;
    }

    function card(key, title, lines, example) {
      const P = PLAN[key], c = P.cfg;
      const err = h('div', { class: 'err', role: 'alert' });
      return h('section', { class: 'plan', id: `plan-${key}` },
        h('span', { class: 'tiny', text: P.for }),
        h('h2', { text: P.full }),
        h('div', { class: 'plan-price' }, h('b', { text: money(c.pricePence) }), h('span', { text: ' / month' })),
        h('p', { class: 'plan-pitch', text: title }),
        h('ul', { class: 'plan-list' }, ...lines.map((t) => h('li', { text: t }))),
        h('p', { class: 'hint', text: example }),
        action(key, err), err);
    }

    function draw() {
      const plus = state.config.plus, pro = state.config.pro;
      const ex = 20000;
      $main.replaceChildren(
        h('section', { class: 'plans-head' },
          h('h1', { text: 'Pay lower fees every month' }),
          h('p', { class: 'muted lead', text: 'Two simple monthly plans. Cancel any time and keep your plan until the end of the month you’ve paid for.' })),
        h('div', { class: 'plans' },
          card('plus', `Pay a ${plus.feePercent}% service fee instead of ${std}% on every job you post.`,
            [`${plus.feePercent}% fee on every job you pay for`, 'Monthly, no contract', 'Paid securely by card through Stripe'],
            `On a £200 job you pay ${money(ex * plus.feePercent / 100)} in fees instead of ${money(ex * std / 100)}.`),
          card('pro', `Keep ${100 - pro.feePercent}% of every job you win instead of ${100 - std}%.`,
            [`Only ${pro.feePercent}% taken from each winning bid`, 'Monthly, no contract', 'Paid securely by card through Stripe'],
            `On a £200 job you receive ${money(ex * (100 - pro.feePercent) / 100)} instead of ${money(ex * (100 - std) / 100)}.`)));
    }
    draw();
  }

  // ---------- haulers & waste carrier checks ----------
  function carrierBadge(c) {
    if (!c) return h('span', { class: 'reg none', text: 'No carrier number' });
    if (c.verified) return h('a', { class: 'reg ok', href: c.registerUrl, target: '_blank', rel: 'noopener', title: `Waste carrier ${c.number}`, text: '✔ Registered carrier' });
    return h('span', { class: 'reg none', text: 'Not verified' });
  }
  const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
  const SEARCH_URL = 'https://environment.data.gov.uk/public-register/view/search-waste-carriers-brokers';

  function resultBox(r) {
    const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener', text });
    const box = (cls, title, ...kids) => h('div', { class: 'check-result ' + cls, role: 'status' }, h('strong', { text: title }), ...kids);
    switch (r.status) {
      case 'registered':
        return box('ok', `✔ ${r.number} is a registered waste carrier`,
          h('dl', { class: 'facts' },
            r.name && h('div', {}, h('dt', { text: 'Business name' }), h('dd', { text: r.name })),
            h('div', {}, h('dt', { text: 'Registered as' }), h('dd', { text: r.registeredAs || r.tier })),
            r.expiresOn && h('div', {}, h('dt', { text: 'Expires' }), h('dd', { text: fmtDate(r.expiresOn) }))),
          h('p', { class: 'hint', text: 'Make sure the business name matches the person or company collecting your waste.' }),
          link(r.registerUrl, 'View the official record ↗'));
      case 'expired':
        return box('bad', `✖ ${r.number} has expired`,
          h('p', { text: `${r.name ? r.name + '’s' : 'This'} registration ran out on ${fmtDate(r.expiresOn)}. Don’t hand waste to a carrier whose registration has expired.` }),
          link(r.registerUrl, 'View the official record ↗'));
      case 'not_found':
        return box('bad', `✖ ${r.number} is not on the register`,
          h('p', { text: 'The Environment Agency has no record of this number. Ask the hauler to check it, or search the register by business name.' }),
          link(SEARCH_URL, 'Search the register by name ↗'));
      case 'other_region':
        return box('warn', `This looks like a ${r.region} registration`,
          h('p', { text: `Carriers in ${r.region} are registered with ${r.registerName}, not the Environment Agency. Check this number on the ${r.registerName} public register.` }));
      case 'unavailable':
        return box('warn', 'The register couldn’t be reached',
          h('p', { text: 'Try again in a few minutes, or check the number yourself on the official register.' }),
          link(SEARCH_URL, 'Open the Environment Agency register ↗'));
      default:
        return box('bad', 'That isn’t a waste carrier number',
          h('p', { text: 'English and Welsh numbers start CBDU (upper tier) or CBDL (lower tier) followed by digits, e.g. CBDU123456.' }));
    }
  }

  async function viewHaulers() {
    document.title = 'Haulers · Waste Warrior';
    const result = h('div');
    const input = h('input', { name: 'number', id: 'carrier-number', placeholder: 'e.g. CBDU123456', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: 20, 'aria-label': 'Waste carrier number' });
    const checkForm = h('form', { class: 'check-row', novalidate: true }, input, h('button', { class: 'btn', type: 'submit', text: 'Check number' }));
    checkForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim()) { input.focus(); return; }
      const btn = checkForm.querySelector('button'); btn.disabled = true; btn.textContent = 'Checking…';
      result.replaceChildren();
      try { result.replaceChildren(resultBox((await api('GET', `/api/carriers/check?number=${encodeURIComponent(input.value)}`)).result)); }
      catch (ex) { result.replaceChildren(h('div', { class: 'err', text: ex.message })); }
      btn.disabled = false; btn.textContent = 'Check number';
    });

    const list = h('div', { class: 'haulers' }, h('div', { class: 'loading', text: 'Loading…' }));
    const mine = h('div');

    function drawMine() {
      if (!state.user) {
        mine.replaceChildren(h('div', { class: 'panel' },
          h('h2', { text: 'Do you collect waste?' }),
          h('p', { class: 'muted', text: 'Add your waste carrier number to appear here and get a “Registered carrier” badge on every bid you place.' }),
          h('a', { class: 'btn', href: '#/register', text: 'Sign up to bid on jobs' })));
        return;
      }
      const c = state.user.carrier;
      const err = h('div', { class: 'err', role: 'alert' });
      const num = h('input', { name: 'number', id: 'my-carrier', value: c ? c.number : '', placeholder: 'e.g. CBDU123456', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: 20 });
      const f = h('form', { class: 'panel', novalidate: true },
        h('h2', { text: 'Your waste carrier number' }),
        c && c.verified
          ? h('div', { class: 'notice', text: `✔ Verified on the Environment Agency register${c.name ? ' as ' + c.name : ''}${c.expiresOn ? `, valid until ${fmtDate(c.expiresOn)}` : ''}.` })
          : h('p', { class: 'muted', text: 'We check your number with the Environment Agency before it shows on your profile and bids.' }),
        h('label', { for: 'my-carrier' }, 'Waste carrier number', num),
        err,
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'submit', text: c ? 'Update and re-check' : 'Verify and save' }),
          c && h('button', { class: 'btn secondary', type: 'button', text: 'Remove', onclick: () => save('') })));
      async function save(value) {
        err.textContent = '';
        f.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
          const { user } = await api('PUT', '/api/me/carrier', { number: value });
          state.user = user;
          toast(value ? 'Waste carrier number verified' : 'Waste carrier number removed');
          drawMine(); loadList();
        } catch (ex) {
          err.textContent = ex.message;
          f.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        }
      }
      f.addEventListener('submit', (e) => { e.preventDefault(); save(num.value); });
      mine.replaceChildren(f);
    }

    async function loadList() {
      try {
        const { haulers } = await api('GET', '/api/haulers');
        list.replaceChildren(...(haulers.length
          ? haulers.map((x) => h('div', { class: 'hauler' },
            h('div', { class: 'avatar', 'aria-hidden': 'true', text: x.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() }),
            h('div', { class: 'grow' },
              h('b', { text: x.name }),
              h('span', { class: 'muted', text: [x.carrier.name && x.carrier.name.toUpperCase() !== x.name.toUpperCase() ? x.carrier.name : '', `${x.jobs} job${x.jobs === 1 ? '' : 's'} done`].filter(Boolean).join(' · ') }),
              h('span', { class: 'regno' }, 'Carrier ', h('a', { href: x.carrier.registerUrl, target: '_blank', rel: 'noopener', text: x.carrier.number }),
                x.carrier.expiresOn ? ` · valid to ${fmtDate(x.carrier.expiresOn)}` : '')),
            h('span', { class: 'reg ok', text: '✔ Registered' })))
          : [h('div', { class: 'empty' }, h('p', { text: 'No haulers have verified their waste carrier number yet.' }))]));
      } catch (e) { list.replaceChildren(h('div', { class: 'err', text: e.message })); }
    }

    $main.replaceChildren(
      h('h1', { text: 'Haulers' }),
      h('p', { class: 'muted lead', text: 'Anyone who takes your waste away must be a registered waste carrier. If your waste is dumped by an unregistered carrier, you can be fined too, so check before you pay.' }),
      h('section', { class: 'panel' },
        h('h2', { text: 'Check a waste carrier number' }),
        h('p', { class: 'muted', text: 'We look the number up live on the Environment Agency public register.' }),
        checkForm, result,
        h('dl', { class: 'tiers' },
          h('dt', { text: 'CBDU…' }), h('dd', { text: 'Upper tier. Needed by anyone who collects other people’s waste for a living.' }),
          h('dt', { text: 'CBDL…' }), h('dd', { text: 'Lower tier. Only for businesses carrying their own low-risk waste, so not enough for clearance jobs.' }))),
      h('section', { class: 'block' }, h('h2', { text: 'Registered haulers on Waste Warrior' }), list),
      h('section', { class: 'block' }, mine));
    drawMine();
    await loadList();
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
      h('div', { class: 'grow' }, h('b', { text: l.title }), h('span', { class: 'muted', text: `${money(l.winningBidCents || l.currentBidCents)} · ${l.bidCount} bid${l.bidCount === 1 ? '' : 's'} · ${when(l)}` })),
      pill);
    const statusPill = (l) => ({
      open: h('span', { class: 'pill' }, timer(l.endsAt, '')),
      closed: h('span', { class: 'pill warn', text: 'Accept & pay' }),
      paid: h('span', { class: 'pill', text: 'Booked' }),
      expired: h('span', { class: 'pill bad', text: 'No bids' }),
      cancelled: h('span', { class: 'pill bad', text: 'Declined' }),
    })[l.status];
    function draw() {
      const list = tab === 'bidding' ? act.bidding : act.selling;
      body.replaceChildren(...(list.length ? list.map((l) => row(l,
        tab === 'bidding'
          ? (l.status === 'open' ? h('span', { class: 'pill' + (l.leading ? '' : ' bad'), text: l.leading ? 'Lowest' : 'Undercut' })
            : l.isWinner ? h('span', { class: 'pill warn', text: { paid: 'Won · booked', closed: 'Won · awaiting customer', cancelled: 'Customer declined' }[l.status] }) : h('span', { class: 'pill bad', text: 'Lost' }))
          : statusPill(l)))
        : [h('div', { class: 'empty' }, h('p', { text: tab === 'bidding' ? 'You haven’t placed any bids yet.' : 'You haven’t posted any jobs yet.' }),
            h('a', { class: 'btn', href: tab === 'bidding' ? '#/' : '#/post', text: tab === 'bidding' ? 'Find jobs' : 'Post a job' }))]));
      tabs.replaceChildren(
        h('button', { class: 'chip', 'aria-pressed': String(tab === 'bidding'), text: `My bids (${act.bidding.length})`, onclick: () => { tab = 'bidding'; draw(); } }),
        h('button', { class: 'chip', 'aria-pressed': String(tab === 'selling'), text: `My jobs (${act.selling.length})`, onclick: () => { tab = 'selling'; draw(); } }));
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
    if (path === '/forgot-password') return recoveryView('forgot');
    if (path === '/reset-password') return recoveryView('reset', query.get('token') || '');
    if (path === '/post') return viewPost();
    if (path === '/dashboard') return viewDashboard();
    if (path === '/haulers') return viewHaulers();
    if (path === '/plus') return viewPlans(query);
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
