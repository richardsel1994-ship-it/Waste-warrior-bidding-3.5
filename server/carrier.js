// Waste carrier registration checks against the Environment Agency public register
// (England). Registration numbers look like CBDU123456 (upper tier) or CBDL123456 (lower tier).
const REGISTER = 'https://environment.data.gov.uk/public-register/waste-carriers-brokers/registration/';
const SEARCH = 'https://environment.data.gov.uk/public-register/view/search-waste-carriers-brokers';
const CACHE_MS = 6 * 3600_000;

const normalise = (v) => String(v || '').toUpperCase().replace(/[\s-]+/g, '').slice(0, 20);

// What kind of number this is, before asking any register.
function classify(raw) {
  const n = normalise(raw);
  if (!n) return { kind: 'empty', number: n };
  if (/^CBDU\d{1,8}$/.test(n)) return { kind: 'ea', number: n, tier: 'Upper tier' };
  if (/^CBDL\d{1,8}$/.test(n)) return { kind: 'ea', number: n, tier: 'Lower tier' };
  if (/^(WCR|SEPA)/.test(n)) return { kind: 'sepa', number: n };
  if (/^ROC/.test(n)) return { kind: 'ni', number: n };
  return { kind: 'invalid', number: n };
}

const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

// Turn the register's record page into lines of plain text.
function pageLines(html) {
  const text = decode(String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|dt|dd|tr|td|th|h\d|section|span|label)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
  return text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Read the value that follows a label, whether it sits on the same line or the next.
function field(lines, label) {
  const re = new RegExp(`^${label}\\s*:?\\s*(.*)$`, 'i');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    if (m[1]) return m[1];
    if (lines[i + 1]) return lines[i + 1];
  }
  return '';
}

// dd/mm/yyyy -> yyyy-mm-dd
function isoDate(s) {
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

function parseRecord(html, number) {
  const lines = pageLines(html);
  const text = lines.join('\n');
  if (!text.toUpperCase().includes(number)) return null;
  const expiresOn = isoDate(field(lines, 'Expiry date'));
  const name = field(lines, 'Business name') || field(lines, 'Name') || '';
  // A page without the record's details (e.g. a "no results" page) is not a registration.
  if (!expiresOn && !name) return null;
  return {
    name,
    registeredAs: field(lines, 'Registered as') || '',
    registeredOn: isoDate(field(lines, 'Registration date')),
    expiresOn,
  };
}

function createCarrierChecker({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();

  // Result statuses:
  //   registered   on the register and in date
  //   expired      on the register but the expiry date has passed
  //   not_found    a valid-looking number the register has no record of
  //   other_region a Scottish or Northern Irish number (different registers)
  //   invalid      not a waste carrier number
  //   unavailable  the register could not be reached
  async function check(raw) {
    const c = classify(raw);
    const base = { number: c.number, registerUrl: SEARCH };
    if (c.kind === 'empty' || c.kind === 'invalid') return { ...base, status: 'invalid' };
    if (c.kind === 'sepa') return { ...base, status: 'other_region', region: 'Scotland', registerName: 'SEPA' };
    if (c.kind === 'ni') return { ...base, status: 'other_region', region: 'Northern Ireland', registerName: 'NIEA' };

    const hit = cache.get(c.number);
    if (hit && hit.at > now() - CACHE_MS) return withExpiry(hit.result);

    const url = REGISTER + encodeURIComponent(c.number);
    let res;
    try {
      res = await fetchImpl(url, { headers: { accept: 'text/html', 'user-agent': 'WasteWarriorBidding/1.0 (waste carrier check)' }, signal: AbortSignal.timeout(8000) });
    } catch {
      return { ...base, status: 'unavailable', tier: c.tier };
    }
    let result;
    if (res.status === 404) result = { number: c.number, status: 'not_found', tier: c.tier, registerUrl: SEARCH };
    else if (!res.ok) return { ...base, status: 'unavailable', tier: c.tier };
    else {
      const rec = parseRecord(await res.text(), c.number);
      if (!rec) result = { number: c.number, status: 'not_found', tier: c.tier, registerUrl: SEARCH };
      else result = { number: c.number, status: 'registered', tier: c.tier, registerUrl: url, ...rec };
    }
    cache.set(c.number, { at: now(), result });
    return withExpiry(result);
  }

  function withExpiry(r) {
    if (r.status === 'registered' && r.expiresOn && Date.parse(`${r.expiresOn}T23:59:59Z`) < now()) return { ...r, status: 'expired' };
    return r;
  }

  return { check };
}

module.exports = { createCarrierChecker, classify, normalise, parseRecord, REGISTER, SEARCH };
