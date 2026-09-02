/* ============================================================
   FinDeck — market data collector
   Runs on GitHub Actions. Writes data/market.json
   Every source is independent: one failing never stops the rest.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(OUT_DIR, { recursive: true });

const out = {
  builtAt: new Date().toISOString(),
  sources: {},
  indices: {},
  stocks: {},
  quotes: {},
  funds: {}
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function ok(name, n)   { out.sources[name] = 'ok:' + n;  console.log('  OK   ' + name + '  (' + n + ' items)'); }
function bad(name, e)  { out.sources[name] = 'fail';     console.log('  FAIL ' + name + '  -> ' + e); }

async function withTimeout(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

/* ---------------- 1. NSE (may be geo-blocked) ---------------- */

const NSE_H = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/'
};

let nseCookie = '';

async function nseWarmup() {
  const r = await withTimeout('https://www.nseindia.com/', { headers: NSE_H });
  const jar = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  nseCookie = jar.map(c => c.split(';')[0]).join('; ');
  if (!nseCookie) throw new Error('no cookie returned');
}

async function nseGet(p) {
  if (!nseCookie) await nseWarmup();
  const r = await withTimeout('https://www.nseindia.com' + p,
                              { headers: { ...NSE_H, Cookie: nseCookie } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function pullNSE() {
  try {
    const j = await nseGet('/api/allIndices');
    let n = 0;
    (j.data || []).forEach(d => {
      out.indices[(d.index || '').trim().toUpperCase()] = {
        last: +d.last, pct: +d.percentChange, prev: +d.previousClose
      };
      n++;
    });
    ok('nse-indices', n);
  } catch (e) { bad('nse-indices', e.message); }

  for (const list of ['NIFTY 50', 'NIFTY NEXT 50']) {
    try {
      const j = await nseGet('/api/equity-stockIndices?index=' + encodeURIComponent(list));
      let n = 0;
      (j.data || []).forEach(d => {
        if (!d.symbol || d.symbol.startsWith('NIFTY')) return;
        out.stocks[d.symbol] = { last: +d.lastPrice, pct: +d.pChange, prev: +d.previousClose };
        n++;
      });
      ok('nse-' + list.replace(/ /g, ''), n);
    } catch (e) { bad('nse-' + list.replace(/ /g, ''), e.message); }
    await new Promise(r => setTimeout(r, 1200));
  }
}

/* ---------------- 2. Stooq — indices & commodities ---------------- */

const STOOQ = {
  '^nsei':  'NIFTY50',   '^bsesn': 'SENSEX',
  '^spx':   'G_SPX',     '^dji':   'G_DJI',    '^ndq': 'G_IXIC',
  '^nkx':   'G_N225',    '^hsi':   'G_HSI',    '^ftm': 'G_UKX',
  '^dax':   'G_DAX',     '^shc':   'G_SHCOMP',
  'gc.f':   'XAU',       'si.f':   'XAG',
  'cl.f':   'WTI',       'ng.f':   'NGUS',     'hg.f': 'LMECU',
  'usdinr': 'USDINR',    'eurinr': 'EURINR',   'gbpinr': 'GBPINR'
};

async function pullStooq() {
  const syms = Object.keys(STOOQ);
  let n = 0;
  try {
    const url = 'https://stooq.com/q/l/?s=' + syms.join('+') +
                '&f=sd2t2ohlcp&h&e=csv';
    const r = await withTimeout(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = (await r.text()).trim().split('\n').slice(1);
    rows.forEach(line => {
      const c = line.split(',');
      const sym = (c[0] || '').toLowerCase();
      const open = parseFloat(c[3]);
      const close = parseFloat(c[6]);
      const id = STOOQ[sym];
      if (!id || !isFinite(close)) return;
      out.quotes[id] = {
        last: close,
        pct: isFinite(open) && open ? (close / open - 1) * 100 : 0,
        prev: isFinite(open) ? open : close
      };
      n++;
    });
    ok('stooq', n);
  } catch (e) { bad('stooq', e.message); }
}

/* ---------------- 3. Crypto ---------------- */

async function pullCrypto() {
  try {
    const r = await withTimeout(
      'https://api.coingecko.com/api/v3/simple/price' +
      '?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true',
      { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.bitcoin)  out.quotes.BTC = { last: j.bitcoin.usd,  pct: j.bitcoin.usd_24h_change  || 0 };
    if (j.ethereum) out.quotes.ETH = { last: j.ethereum.usd, pct: j.ethereum.usd_24h_change || 0 };
    ok('crypto', 2);
  } catch (e) { bad('crypto', e.message); }
}

/* ---------------- 4. Currencies ---------------- */

async function pullFX() {
  try {
    const r = await withTimeout('https://api.frankfurter.app/latest?from=USD&to=INR,EUR,GBP,JPY');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const usdinr = j.rates && j.rates.INR;
    if (usdinr) {
      if (!out.quotes.USDINR) out.quotes.USDINR = { last: usdinr, pct: 0 };
      if (j.rates.EUR) out.quotes.EURINR = { last: usdinr / j.rates.EUR, pct: 0 };
      if (j.rates.GBP) out.quotes.GBPINR = { last: usdinr / j.rates.GBP, pct: 0 };
      if (j.rates.JPY) out.quotes.JPYINR = { last: (usdinr / j.rates.JPY) * 100, pct: 0 };
    }
    ok('fx', 4);
  } catch (e) { bad('fx', e.message); }
}

/* ---------------- 5. Mutual fund NAVs ---------------- */

const FUNDS = {
  '122639': 'Parag Parikh Flexi Cap',
  '118825': 'Nippon India Small Cap',
  '118989': 'HDFC Mid-Cap Opportunities',
  '120465': 'ICICI Pru Bluechip',
  '119775': 'Quant Small Cap',
  '125497': 'Motilal Oswal Midcap',
  '118533': 'SBI Contra Fund',
  '120716': 'Mirae Asset Large Cap',
  '119063': 'HDFC Flexi Cap',
  '120847': 'Axis Small Cap'
};

async function pullFunds() {
  let n = 0;
  for (const [code, name] of Object.entries(FUNDS)) {
    try {
      const r = await withTimeout('https://api.mfapi.in/mf/' + code);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const d = j.data || [];
      if (!d.length) continue;
      const nav  = parseFloat(d[0].nav);
      const prev = parseFloat((d[1] || d[0]).nav);
      out.funds[code] = {
        name: (j.meta && j.meta.scheme_name) || name,
        nav, date: d[0].date,
        pct: prev ? (nav / prev - 1) * 100 : 0,
        history: d.slice(0, 400).map(x => [x.date, parseFloat(x.nav)])
      };
      n++;
    } catch (e) { /* skip this fund */ }
    await new Promise(r => setTimeout(r, 250));
  }
  n ? ok('mutual-funds', n) : bad('mutual-funds', 'all failed');
}

/* ---------------- run ---------------- */

(async () => {
  console.log('--- FinDeck collector ---');
  await pullNSE();
  await pullStooq();
  await pullCrypto();
  await pullFX();
  await pullFunds();

  fs.writeFileSync(path.join(OUT_DIR, 'market.json'), JSON.stringify(out));

  console.log('--- summary ---');
  Object.entries(out.sources).forEach(([k, v]) => console.log('  ' + k + ': ' + v));
  console.log('indices=' + Object.keys(out.indices).length +
              ' stocks=' + Object.keys(out.stocks).length +
              ' quotes=' + Object.keys(out.quotes).length +
              ' funds=' + Object.keys(out.funds).length);
})();
