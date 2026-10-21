// Public, server-rendered pages: the front page shell, local search pages, the haulers page,
// terms, privacy, robots.txt and sitemap.xml. Everything here is readable without an account
// (and by Google). Job details, photos and bidding stay members-only.
const fs = require('node:fs');
const path = require('node:path');

const TOWNS = [
  { slug: 'hull', name: 'Hull', postcodes: ['HU1', 'HU2', 'HU3', 'HU4', 'HU5', 'HU6', 'HU7', 'HU8', 'HU9'], note: 'from the city centre and the Avenues to Bransholme, Sutton, Orchard Park and east Hull' },
  { slug: 'beverley', name: 'Beverley', postcodes: ['HU17'], note: 'including Molescroft, Woodmansey and the villages around the Westwood' },
  { slug: 'cottingham', name: 'Cottingham', postcodes: ['HU16'], note: 'including Skidby and the streets around the university halls' },
  { slug: 'hessle', name: 'Hessle', postcodes: ['HU13'], note: 'from the foreshore up to Boothferry Road' },
  { slug: 'anlaby', name: 'Anlaby', postcodes: ['HU10'], note: 'including Anlaby Common and Kirk Ella' },
  { slug: 'willerby', name: 'Willerby', postcodes: ['HU10'], note: 'including Kirk Ella and West Ella' },
  { slug: 'hedon', name: 'Hedon', postcodes: ['HU12'], note: 'including Preston, Paull and Thorngumbald' },
  { slug: 'withernsea', name: 'Withernsea', postcodes: ['HU19'], note: 'and the Holderness coast villages' },
  { slug: 'driffield', name: 'Driffield', postcodes: ['YO25'], note: 'and the surrounding Wolds villages' },
  { slug: 'bridlington', name: 'Bridlington', postcodes: ['YO15', 'YO16'], note: 'including Sewerby and Flamborough' },
];

const SERVICES = [
  { slug: 'sofa-removal', name: 'Sofa removal', short: 'sofa', what: 'an old sofa, armchair or corner unit', price: '£25–£60 for a single sofa', tip: 'Measure doorways and say if it comes apart. If it has a fire safety label and is in good condition, mention it: some collectors can pass it on for reuse.' },
  { slug: 'mattress-removal', name: 'Mattress removal', short: 'mattress', what: 'one or more mattresses or bed bases', price: '£20–£45 per mattress', tip: 'Bag the mattress if it has been stored outside or in a damp garage, and say whether there are stairs.' },
  { slug: 'fridge-freezer-removal', name: 'Fridge and freezer removal', short: 'fridge or freezer', what: 'a fridge, freezer or other large appliance', price: '£30–£200 depending on size', tip: 'Fridges and freezers contain gases that have to be removed at a licensed site, so they cost more than other items. Defrost and empty it first.' },
  { slug: 'garden-waste-removal', name: 'Garden waste removal', short: 'garden waste', what: 'hedge cuttings, branches, turf, soil or a full garden clearance', price: '£60–£150 for a van load, £400–£600 for a full clearance', tip: 'Say roughly how many bags or how big the pile is, and whether there is soil or rubble mixed in, as that is much heavier.' },
  { slug: 'house-clearance', name: 'House clearance', short: 'house clearance', what: 'a whole house, flat, loft or garage', price: 'around £1,000 for a typical house', tip: 'Add photos of every room, and say what (if anything) should be kept, donated or recycled.' },
  { slug: 'builders-waste-removal', name: 'Builders’ waste removal', short: 'builders’ waste', what: 'rubble, plasterboard, old kitchens and bathroom rip-outs', price: '£250–£400 for a bathroom rip-out', tip: 'Plasterboard and asbestos have to be kept separate. If you suspect asbestos, say so, as it needs a specialist.' },
];

const ESTIMATES = [
  ['Bin bag (each)', '£1.50–£3.00'],
  ['Single chair', '£10–£30'],
  ['Fridge', '£30–£200'],
  ['Bathroom rip-out', '£250–£400'],
  ['Garden clearance', '£400–£600'],
  ['House clearance', '£1,000'],
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function registerPublicPages(app, { q, one, config, feePercent, proFeePercent, proPricePence }) {
  const baseFor = (req) => (/localhost|127\.0\.0\.1/.test(config.baseUrl) ? `${req.protocol}://${req.get('host')}` : config.baseUrl);
  const money = (p) => `£${(p / 100).toFixed(2).replace(/\.00$/, '')}`;

  function openJobsNear(town) {
    const rows = q("SELECT location FROM listings WHERE status = 'open' AND ends_at > ?", Date.now());
    const terms = [town.name.toLowerCase(), ...town.postcodes.map((p) => p.toLowerCase())];
    return rows.filter((r) => {
      const loc = String(r.location).toLowerCase();
      return terms.some((t) => (/\d/.test(t) ? new RegExp(`\\b${t}\\b`).test(loc) : loc.includes(t)));
    }).length;
  }

  function areaLinks() {
    return `<ul class="pp-links">${TOWNS.map((t) => `<li><a href="/rubbish-removal/${t.slug}">Rubbish removal ${esc(t.name)}</a></li>`).join('')}</ul>`;
  }
  function serviceLinks() {
    return `<ul class="pp-links">${SERVICES.map((s) => `<li><a href="/services/${s.slug}">${esc(s.name)}</a></li>`).join('')}</ul>`;
  }

  function layout(req, { title, description, canonical, body, jsonLd }) {
    const base = baseFor(req);
    return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(base + canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Waste Warrior Bidding">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(base + canonical)}">
  <meta property="og:image" content="${esc(base)}/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#0a2259">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/app.css">
  <link rel="stylesheet" href="/pages.css">
  ${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="wrap bar">
      <a href="/" class="brand"><span class="brand-mark" aria-hidden="true">♻</span> Waste Warrior</a>
      <nav class="pp-nav" aria-label="Main">
        <a class="pp-hide-sm" href="/for-haulers">For haulers</a>
        <a href="/#/login">Log in</a>
        <a class="nav-cta" href="/#/register">Sign up free</a>
      </nav>
    </div>
  </header>
  <main id="main" class="wrap pp-main">${body}</main>
  ${footer()}
</body>
</html>`;
  }

  function footer() {
    return `<footer class="site-footer">
    <div class="wrap pp-foot">
      <div><b>Waste Warrior Bidding</b><p class="muted">Local haulers bid to clear your waste. Lowest bid wins.</p>
        <ul class="pp-links"><li><a href="/for-haulers">For haulers</a></li><li><a href="/terms">Terms</a></li><li><a href="/privacy">Privacy</a></li></ul></div>
      <div><b>Areas</b>${areaLinks()}</div>
      <div><b>Services</b>${serviceLinks()}</div>
    </div>
    <div class="wrap foot"><span>© ${new Date().getFullYear()} Waste Warrior Bidding</span><span>Payments processed securely by Stripe</span></div>
  </footer>`;
  }

  const howItWorks = () => `<section class="block"><h2>How it works</h2><div class="steps pp-steps">
    <div class="step"><img class="step-img" src="/img/step-post.svg" alt=""><div class="n">1</div><h3>Post your job</h3><p class="muted">Add photos, say what needs clearing, when it can be collected and the most you want to pay. It takes about two minutes and it’s free.</p></div>
    <div class="step"><img class="step-img" src="/img/step-bid.svg" alt=""><div class="n">2</div><h3>Haulers bid it down</h3><p class="muted">Local waste carriers compete for the job. Every new bid has to beat the lowest one, so the price only goes down.</p></div>
    <div class="step"><img class="step-img" src="/img/step-pay.svg" alt=""><div class="n">3</div><h3>Book and pay</h3><p class="muted">When bidding closes, book the lowest bid or a hauler with better reviews, and pay securely by card. The hauler is only paid once you confirm the collection.</p></div>
  </div></section>`;

  const dutyOfCare = () => `<section class="pp-callout"><h2><img class="h-ico" src="/img/icons/shield.svg" alt=""> Don’t get fined for someone else’s fly-tipping</h2>
    <p>By law you have to check that whoever takes your waste is a registered waste carrier. If you hand it to a “man with a van” who dumps it, the council can trace it back to you and you can be fined too.</p>
    <p>On Waste Warrior, only registered waste carriers can bid. Every hauler’s carrier number is checked against the Environment Agency public register and shown as a <b>✔ Registered carrier</b> badge on their bid, so you know who you’re dealing with before you pay.</p></section>`;

  const priceTable = () => `<table class="estimates"><thead><tr><th scope="col">Job type</th><th scope="col">Rough budget</th></tr></thead><tbody>${ESTIMATES.map(([a, b]) => `<tr><th scope="row">${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</tbody></table>
    <p class="hint">Rough guides only. The final price depends on the amount, access and location, and haulers compete to beat your budget.</p>`;

  const cta = (text) => `<section class="cta"><div><h2>${esc(text)}</h2><p>Post a job in two minutes and let local haulers compete for it.</p></div><a class="btn accent lg" href="/#/register">Post a job free</a></section>`;

  const faq = (place) => [
    [`How much does rubbish removal cost in ${place}?`, 'You set the most you’re willing to pay, and haulers bid below it. Small loads such as a chair or a few bags often go for £10–£30, a full van for £150–£250, and a whole house clearance around £1,000.'],
    ['Is it free to post a job?', `Yes. You only pay if you accept a bid. A ${feePercent}% service fee is added at checkout.`],
    ['When does the hauler get my address?', 'Only after you accept their bid and pay. Before that, haulers only see your town or postcode area.'],
    ['Are the haulers licensed?', 'Yes. Only haulers with a waste carrier number verified on the Environment Agency register can bid, and registrations are re-checked regularly.'],
    ['Do I have to take the cheapest bid?', 'No. When bidding closes the cheapest bid is picked for you, but you can book any hauler who bid, for example one with better reviews.'],
    ['What if the hauler doesn’t turn up?', 'The hauler is only paid once you confirm the collection. If something goes wrong, report a problem and their payment is held while it’s sorted out.'],
  ];
  const faqHtml = (items) => `<section class="block"><h2>Questions</h2><div class="pp-faq">${items.map(([qq, a]) => `<details><summary>${esc(qq)}</summary><p>${esc(a)}</p></details>`).join('')}</div></section>`;
  const faqLd = (items) => ({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map(([qq, a]) => ({ '@type': 'Question', name: qq, acceptedAnswer: { '@type': 'Answer', text: a } })) });

  // ---------- town pages ----------
  app.get('/rubbish-removal', (req, res) => res.redirect(301, '/rubbish-removal/hull'));
  app.get('/rubbish-removal/:town', (req, res, next) => {
    const t = TOWNS.find((x) => x.slug === req.params.town);
    if (!t) return next();
    const open = openJobsNear(t);
    const items = faq(t.name);
    res.send(layout(req, {
      title: `Rubbish Removal ${t.name} | Local haulers bid, lowest price wins | Waste Warrior`,
      description: `Cheap rubbish removal in ${t.name} (${t.postcodes.join(', ')}). Post your job free, registered local waste carriers bid the price down, and you pay the lowest bid.`,
      canonical: `/rubbish-removal/${t.slug}`,
      jsonLd: faqLd(items),
      body: `<section class="hero pp-hero"><div class="hero-copy">
        <span class="eyebrow">${esc(t.name)} · ${esc(t.postcodes.join(', '))}</span>
        <h1>Rubbish removal in ${esc(t.name)}, priced by competition</h1>
        <p>Post what needs clearing in ${esc(t.name)} ${esc(t.note)}. Local registered waste carriers bid against each other for the job, and the lowest price wins.</p>
        <div class="actions"><a class="btn accent lg" href="/#/register">Post a job free</a><a class="btn ghost lg" href="/for-haulers">I’m a hauler</a></div>
        ${open ? `<p class="pp-live">${open} job${open === 1 ? '' : 's'} near ${esc(t.name)} taking bids right now</p>` : ''}
      </div><img class="hero-art" src="/img/van.svg" alt=""></section>
      ${howItWorks()}
      <section class="block"><h2>What it costs in ${esc(t.name)}</h2>${priceTable()}</section>
      ${dutyOfCare()}
      <section class="block"><h2>What we can clear</h2><p class="muted">Household rubbish, furniture, appliances, garden waste, builders’ rubble, mixed recycling and commercial waste.</p>${serviceLinks()}</section>
      ${faqHtml(items)}
      ${cta(`Got rubbish to shift in ${t.name}?`)}
      <section class="block"><h2>Other areas we cover</h2>${areaLinks()}</section>`,
    }));
  });

  // ---------- service pages ----------
  app.get('/services/:service', (req, res, next) => {
    const s = SERVICES.find((x) => x.slug === req.params.service);
    if (!s) return next();
    const items = [[`How much does ${s.short} removal cost?`, `As a rough guide, ${s.price}. On Waste Warrior you set your maximum and local haulers bid below it.`], ...faq('Hull').slice(1)];
    res.send(layout(req, {
      title: `${s.name} Hull & East Yorkshire | Lowest bid wins | Waste Warrior`,
      description: `${s.name} in Hull and East Yorkshire. Post ${s.what} with photos, let registered local haulers bid the price down, and pay the lowest bid securely online.`,
      canonical: `/services/${s.slug}`,
      jsonLd: faqLd(items),
      body: `<section class="hero pp-hero"><div class="hero-copy">
        <span class="eyebrow">Hull &amp; East Yorkshire</span>
        <h1>${esc(s.name)} for less</h1>
        <p>Need to get rid of ${esc(s.what)}? Post it with a photo, set the most you’ll pay, and local haulers bid each other down for the job.</p>
        <div class="actions"><a class="btn accent lg" href="/#/register">Post a job free</a></div>
      </div><img class="hero-art" src="/img/van.svg" alt=""></section>
      <section class="block pp-two">
        <div class="panel"><h2>Typical price</h2><p class="pp-big">${esc(s.price)}</p><p class="hint">A rough guide. Bids often come in lower.</p></div>
        <div class="panel"><h2>Tip for a better price</h2><p>${esc(s.tip)}</p></div>
      </section>
      ${howItWorks()}
      ${dutyOfCare()}
      ${faqHtml(items)}
      ${cta(`Get your ${s.short} collected`)}
      <section class="block"><h2>Areas</h2>${areaLinks()}</section>`,
    }));
  });

  // ---------- for haulers ----------
  app.get('/for-haulers', (req, res) => {
    const keep = 100 - feePercent, keepPro = 100 - proFeePercent;
    const items = [
      ['Does it cost anything to join?', `No. Signing up and bidding are free. When you win and the customer pays, ${feePercent}% is taken from your bid and you keep ${keep}%.`],
      ['How do I get paid?', 'Add your bank account or debit card on Stripe’s secure page. The customer pays up front. When you’ve done the job, tap Collected: your share is released as soon as the customer confirms, or automatically after 24 hours, and Stripe pays it into your bank.'],
      ['Do I need a waste carrier licence?', 'Yes. Only registered waste carriers can bid. Anyone collecting other people’s waste needs an upper-tier registration (CBDU…) from the Environment Agency. Add your number and we check it on the public register in seconds.'],
      ['Is there a way to keep more?', `Hauler Pro is ${money(proPricePence)} a month and lowers the fee to ${proFeePercent}%, so you keep ${keepPro}% of every job.`],
    ];
    res.send(layout(req, {
      title: 'Waste Removal Jobs in Hull & East Yorkshire for Haulers | Waste Warrior',
      description: `Find waste removal and clearance jobs near you. Bid on local jobs with photos, keep ${keep}% of every job you win, and get paid straight to your bank.`,
      canonical: '/for-haulers',
      jsonLd: faqLd(items),
      body: `<section class="hero pp-hero"><div class="hero-copy">
        <span class="eyebrow">For waste carriers and clearance firms</span>
        <h1>Fill your van with local jobs</h1>
        <p>Customers post waste jobs with photos, dates and access notes. You bid what you want to do it for. Win the job, collect the waste, and get paid straight into your bank.</p>
        <div class="actions"><a class="btn accent lg" href="/#/register">Sign up free and start bidding</a></div>
      </div><img class="hero-art" src="/img/van.svg" alt=""></section>
      <section class="block"><div class="features pp-features">
        <div class="feature"><div class="ico"><img src="/img/icons/photo.svg" alt=""></div><h3>Know the job before you go</h3><p class="muted">Photos, amount, dates and access notes on every job, so no wasted trips.</p></div>
        <div class="feature"><div class="ico"><img src="/img/icons/pound.svg" alt=""></div><h3>Keep ${keep}%</h3><p class="muted">No sign-up fee, no monthly fee and no paying for leads. You only pay when you win and get paid.</p></div>
        <div class="feature"><div class="ico"><img src="/img/icons/bank.svg" alt=""></div><h3>Paid the same day</h3><p class="muted">Customers pay up front. Tap “Collected” when you’re done and your share is released as soon as they confirm, or automatically after 24 hours.</p></div>
        <div class="feature"><div class="ico"><img src="/img/icons/star.svg" alt=""></div><h3>Win on reviews, not just price</h3><p class="muted">Customers can book any bid, so good reviews win you work even when you’re not the cheapest.</p></div>
      </div></section>
      <section class="block"><h2>Getting started takes five minutes</h2><div class="steps pp-steps">
        <div class="step"><div class="n">1</div><h3>Sign up</h3><p class="muted">Create a free account with your email.</p></div>
        <div class="step"><div class="n">2</div><h3>Add your carrier number</h3><p class="muted">On the Haulers page. We check it live with the Environment Agency. You need it to bid.</p></div>
        <div class="step"><div class="n">3</div><h3>Set up payouts</h3><p class="muted">Add your bank on Stripe’s secure page so you’re paid automatically.</p></div>
        <div class="step"><div class="n">4</div><h3>Bid, collect, get paid</h3><p class="muted">Bid on jobs that suit your route. If you’re booked, collect the waste, tap Collected and get paid.</p></div>
      </div></section>
      <section class="block pp-two">
        <div class="panel"><h2>Example</h2><p>You win a garden clearance at <b>£200</b>.</p><p>Standard: you receive <b>${money(200 * keep)}</b>.</p><p>With Hauler Pro: you receive <b>${money(200 * keepPro)}</b>.</p></div>
        <div class="panel"><h2>Areas</h2><p class="muted">We’re starting in Hull and East Yorkshire.</p>${areaLinks()}</div>
      </section>
      ${faqHtml(items)}
      <section class="cta"><div><h2>Ready for more work?</h2><p>Join free. You only pay when you win and get paid.</p></div><a class="btn accent lg" href="/#/register">Sign up free</a></section>`,
    }));
  });

  // ---------- terms & privacy ----------
  const contact = () => (config.contactEmail ? `<p>Questions? Email <a href="mailto:${esc(config.contactEmail)}">${esc(config.contactEmail)}</a>.</p>` : '<p>Questions? Contact us through your account on the site.</p>');
  const updated = '21 October 2026';

  app.get('/terms', (req, res) => res.send(layout(req, {
    title: 'Terms of use | Waste Warrior Bidding',
    description: 'The terms for using Waste Warrior Bidding as a customer or hauler.',
    canonical: '/terms',
    body: `<article class="pp-doc panel"><h1>Terms of use</h1><p class="hint">Last updated ${updated}</p>
      <h2>1. What Waste Warrior is</h2><p>Waste Warrior Bidding is an online marketplace. Customers post waste removal jobs and independent haulers bid to do them. We are not a waste carrier and do not collect waste ourselves. The contract to collect the waste is between the customer and the hauler whose bid is accepted.</p>
      <h2>2. Accounts</h2><p>You must be 18 or over and give accurate details. Keep your password private. You are responsible for what happens on your account.</p>
      <h2>3. Posting a job</h2><p>Describe the waste honestly, including anything hazardous, heavy or hard to reach, and only post photos you have the right to use. Hazardous waste such as asbestos, chemicals or clinical waste must be clearly described and may need a specialist. Bidding closes at the advertised time. You may then book and pay for any hauler’s bid (the lowest is selected by default), or decline them all. Once the waste has been collected, confirm it or report a problem promptly.</p>
      <h2>4. Bidding as a hauler</h2><p>Every bid is a price for the whole job as described. Anyone collecting other people’s waste must hold a valid waste carrier registration and dispose of waste lawfully at licensed sites. If the job differs materially from the description, agree any change with the customer before starting. Do not use details from the site to arrange jobs off the platform.</p>
      <h2>5. Payments and fees</h2><p>Customers pay through Stripe when they accept a bid. A service fee of ${feePercent}% is added to the customer’s price, and ${feePercent}% is taken from the hauler’s winning bid (lower rates apply to Waste Warrior Plus and Hauler Pro subscribers). The hauler’s share is held until the customer confirms the collection, or until ${config.autoReleaseHours} hours after the hauler marks the job collected if the customer has not reported a problem, and is then paid out through Stripe Connect. Subscriptions renew monthly until cancelled and stay active until the end of the paid month.</p>
      <h2>6. Cancellations and problems</h2><p>If a hauler cannot attend, they must tell the customer as soon as possible. If a job is not carried out, contact us and we will look into refunding the customer. Nothing in these terms affects your statutory rights.</p>
      <h2>7. Our responsibility</h2><p>We check waste carrier numbers against the public register when haulers add them, but we do not supervise the work. To the extent the law allows, we are not liable for the acts of customers or haulers. We do not exclude liability for death or personal injury caused by our negligence, or for fraud.</p>
      <h2>8. Removing content and accounts</h2><p>We may remove jobs, bids or accounts that break these terms or the law.</p>
      <h2>9. Law</h2><p>These terms are governed by the law of England and Wales.</p>
      ${contact()}</article>`,
  })));

  app.get('/privacy', (req, res) => res.send(layout(req, {
    title: 'Privacy | Waste Warrior Bidding',
    description: 'How Waste Warrior Bidding uses and protects your personal information.',
    canonical: '/privacy',
    body: `<article class="pp-doc panel"><h1>Privacy notice</h1><p class="hint">Last updated ${updated}</p>
      <h2>What we collect</h2><p>Your name, email address and a securely hashed password; the jobs you post (description, photos, town or postcode area, collection address and dates); the bids you place; your waste carrier number if you add one; and records of payments and subscriptions.</p>
      <h2>What we don’t collect</h2><p>Card and bank details are entered on Stripe’s pages and are never seen or stored by Waste Warrior.</p>
      <h2>Who sees what</h2><p>Other members see your first name on jobs and bids, and your town or postcode area. Your full collection address and email are only shared with the hauler whose bid you accept and pay for, and the customer sees the winning hauler’s name and email.</p>
      <h2>Why we use it</h2><p>To run the marketplace, take payments and pay haulers, prevent fraud, and meet legal duties. We use a single login cookie to keep you signed in; we don’t use advertising or tracking cookies.</p>
      <h2>Who we share it with</h2><p>Stripe (payments and payouts), our hosting provider, the Environment Agency public register (only the waste carrier number you ask us to check), and an email provider for password reset emails.</p>
      <h2>How long we keep it</h2><p>For as long as you have an account, and payment records for as long as the law requires (normally six years).</p>
      <h2>Your rights</h2><p>You can ask for a copy of your data, ask us to correct or delete it, or object to how we use it. You can also complain to the Information Commissioner’s Office (ico.org.uk).</p>
      ${contact()}</article>`,
  })));

  // ---------- robots & sitemap ----------
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /uploads/\n\nSitemap: ${baseFor(req)}/sitemap.xml\n`);
  });
  app.get('/sitemap.xml', (req, res) => {
    const base = baseFor(req);
    const paths = ['/', '/for-haulers', ...TOWNS.map((t) => `/rubbish-removal/${t.slug}`), ...SERVICES.map((s) => `/services/${s.slug}`), '/terms', '/privacy'];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `  <url><loc>${esc(base + p)}</loc></url>`).join('\n')}\n</urlset>\n`);
  });

  // ---------- the app shell, with absolute share links filled in ----------
  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  let indexTpl = null;
  app.get(['/', '/index.html'], (req, res) => {
    if (!indexTpl || !config.production) indexTpl = fs.readFileSync(indexPath, 'utf8');
    res.type('html').send(indexTpl.replace(/__BASE_URL__/g, esc(baseFor(req))));
  });

  // ---------- public teaser for the front page (no titles, photos, descriptions or addresses) ----------
  app.get('/api/public/overview', (req, res) => {
    const nowMs = Date.now();
    const rows = q("SELECT id, category, load_size, location, start_price_cents, ends_at FROM listings WHERE status = 'open' AND ends_at > ? ORDER BY ends_at ASC LIMIT 12", nowMs);
    const jobs = rows.map((l) => {
      const low = one('SELECT MIN(amount_cents) AS m, COUNT(*) AS n FROM bids WHERE listing_id = ?', l.id);
      return { category: l.category, loadSize: l.load_size, area: l.location, currentBidCents: low.n ? low.m : l.start_price_cents, bidCount: low.n, endsAt: l.ends_at };
    });
    const booked = one("SELECT COUNT(*) AS n FROM listings WHERE status = 'paid'").n;
    const posted = one("SELECT COUNT(*) AS n FROM listings WHERE status NOT IN ('expired', 'removed')").n;
    const open = one("SELECT COUNT(*) AS n FROM listings WHERE status = 'open' AND ends_at > ?", nowMs).n;
    const haulers = one("SELECT COUNT(*) AS n FROM users WHERE carrier_number != '' AND carrier_status = 'registered'").n;
    res.json({ jobs, stats: { posted, booked, open, haulers }, towns: TOWNS.map((t) => ({ slug: t.slug, name: t.name })) });
  });
}

module.exports = { registerPublicPages, TOWNS, SERVICES };
