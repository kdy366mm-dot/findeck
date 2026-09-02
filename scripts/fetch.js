/* ============================================================
   FinDeck data fetcher — runs on GitHub Actions
   Writes data/market.json
   ============================================================ */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'market.json');

/* ---------- symbol map: yahoo symbol -> dashboard id ---------- */
const MAP = {
  // Indian indices
  '^NSEI'      : 'NIFTY50',
  '^BSESN'     : 'SENSEX',
  '^NSEBANK'   : 'BANKNIFTY',
  '^CNXFIN'    : 'FINNIFTY',
  '^NSEMDCP50' : 'MIDCAP',
  '^CNXSC'     : 'SMALLCAP',
  '^INDIAVIX'  : 'VIX',
  // Indian sectors
  '^CNXIT'      : 'S_IT',
  '^CNXAUTO'    : 'S_AUTO',
  '^CNXFMCG'    : 'S_FMCG',
  '^CNXPHARMA'  : 'S_PHARMA',
  '^CNXMETAL'   : 'S_METAL',
  '^CNXREALTY'  : 'S_REALTY',
  '^CNXENERGY'  : 'S_ENERGY',
  '^CNXPSUBANK' : 'S_PSUBANK',
  '^CNXMEDIA'   : 'S_MEDIA',
  '^CNXINFRA'   : 'S_INFRA',
  // Commodities (USD)
  'GC=F' : 'XAU',
  'SI=F' : 'XAG',
  'CL=F' : 'WTI',
  'BZ=F' : 'BRENT',
  'NG=F' : 'NGUS',
  'HG=F' : 'LMECU',
  // Currency
  'INR=X'    : 'USDINR',
  'EURINR=X' : 'EURINR',
  'GBPINR=X' : 'GBPINR',
  'JPYINR=X' : 'JPYINR',
  'DX-Y.NYB' : 'DXY',
  // Crypto
  'BTC-USD' : 'BTC',
  'ETH-USD' : 'ETH',
  // US yields
  '^TNX' : 'B_US10',
  '^FVX' : 'B_US5',
  '^TYX' : 'B_US30',
  // Global indices
  '^DJI'      : 'G_DJI',
  '^GSPC'     : 'G_SPX',
  '^IXIC'     : 'G_IXIC',
  '^RUT'      : 'G_RUT',
  '^GSPTSE'   : 'G_GSPTSE',
  '^BVSP'     : 'G_BVSP',
  '^FTSE'     : 'G_UKX',
  '^GDAXI'    : 'G_DAX',
  '^FCHI'     : 'G_CAC',
  '^STOXX50E' : 'G_SX5E',
  '^SSMI'     : 'G_SMI',
  '^N225'     : 'G_N225',
  '^HSI'      : 'G_HSI',
  '000001.SS' : 'G_SHCOMP',
  '^KS11'     : 'G_KOSPI',
  '^TWII'     : 'G_TWII',
  '^STI'      : 'G_STI',
  '^AXJO'     : 'G_AXJO',
  '^JKSE'     : 'G_JKSE'
};

/* NSE stocks — dashboard uses E_SYMBOL */
const STOCKS = ['RELIANCE','TCS','HDFCBANK','ICICIBANK','INFY','BHARTIARTL','SBIN','ITC',
'LT','HINDUNILVR','KOTAKBANK','AXISBANK','MARUTI','SUNPHARMA','TATAMOTORS','TITAN',
'ULTRACEMCO','BAJFINANCE','NTPC','POWERGRID','ONGC','TATASTEEL','JSWSTEEL','HINDALCO',
'WIPRO','HCLTECH','ADANIENT','ADANIPORTS','COALINDIA','ASIANPAINT','NESTLEIND','DMART',
'TRENT','BEL','HAL','IRFC','VBL','PERSISTENT','CDSL','POLYCAB','MAZDOCK','SUZLON',
'IREDA','YESBANK','PNB','IDFCFIRSTB','JIOFIN','LICI','DIXON','ZOMATO'];
STOCKS.forEach(s => { MAP[s + '.NS'] = 'E_' + s; });

/* ---------- helpers ---------- */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function yahoo(sym) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
              encodeURIComponent(sym) + '?interval=1d&range=5d';
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || m.regularMarketPrice == null) throw new Error('no price');
  const px   = m.regularMarketPrice;
  const prev = m.chartPreviousClose ?? m.previousClose ?? px;
  return { p: +px.toFixed(4), pc: +prev.toFixed(4),
           c: +(((px / prev) - 1) * 100).toFixed(2) };
}

/* run in small batches so we stay polite */
async function batch(symbols, size = 6) {
  const out = {};
  let ok = 0, fail = 0;
  for (let i = 0; i < symbols.length; i += size) {
    const slice = symbols.slice(i, i + size);
    await Promise.all(slice.map(async sym => {
      try {
        out[MAP[sym]] = await yahoo(sym);
        ok++;
      } catch (e) {
        fail++;
        console.log('   skip ' + sym + ' (' + e.message + ')');
      }
    }));
    await sleep(250);
  }
  console.log('   yahoo: ' + ok + ' ok, ' + fail + ' skipped');
  return out;
}

/* ---------- optional: try NSE directly (usually blocked) ---------- */
async function tryNSE(q) {
  try {
    const H = { 'User-Agent': UA, 'Accept': 'application/json',
                'Referer': 'https://www.nseindia.com/' };
    const home = await fetch('https://www.nseindia.com/', { headers: H });
    const jar = (home.headers.getSetCookie?.() || [])
                  .map(c => c.split(';')[0]).join('; ');
    const r = await fetch('https://www.nseindia.com/api/allIndices',
                          { headers: { ...H, Cookie: jar } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const NSEMAP = {
      'NIFTY 50':'NIFTY50', 'NIFTY BANK':'BANKNIFTY',
      'NIFTY FINANCIAL SERVICES':'FINNIFTY', 'NIFTY MIDCAP 100':'MIDCAP',
      'NIFTY SMALLCAP 100':'SMALLCAP', 'NIFTY NEXT 50':'NEXT50',
      'INDIA VIX':'VIX'
    };
    let n = 0;
    (j.data || []).forEach(d => {
      const id = NSEMAP[(d.index || '').trim().toUpperCase()];
      if (id && d.last) {
        q[id] = { p: +d.last, pc: +d.previousClose, c: +d.percentChange };
        n++;
      }
    });
    console.log('   nse: ' + n + ' indices (direct hit worked!)');
  } catch (e) {
    console.log('   nse: unavailable from this runner (' + e.message + ') — expected');
  }
}

/* ---------- derive MCX-style rupee bullion from spot ---------- */
function deriveBullion(q) {
  const usdinr = q.USDINR?.p, xau = q.XAU, xag = q.XAG;
  if (!usdinr) return;
  if (xau) {
    const p = (xau.p * usdinr / 31.1035) * 10;
    const pc = (xau.pc * usdinr / 31.1035) * 10;
    q.M_GOLD  = { p: +p.toFixed(0), pc: +pc.toFixed(0), c: xau.c, derived: 1 };
    q.M_GOLDM = { p: +p.toFixed(0), pc: +pc.toFixed(0), c: xau.c, derived: 1 };
  }
  if (xag) {
    const p = (xag.p * usdinr / 31.1035) * 1000;
    const pc = (xag.pc * usdinr / 31.1035) * 1000;
    q.M_SILVER  = { p: +p.toFixed(0), pc: +pc.toFixed(0), c: xag.c, derived: 1 };
    q.M_SILVERM = { p: +p.toFixed(0), pc: +pc.toFixed(0), c: xag.c, derived: 1 };
  }
  if (q.WTI) {
    const p = q.WTI.p * usdinr;
    q.M_CRUDE = { p: +p.toFixed(0), pc: +(q.WTI.pc * usdinr).toFixed(0),
                  c: q.WTI.c, derived: 1 };
  }
}

/* ---------- mutual fund NAVs (mfapi.in — always works) ---------- */
const FUNDS = {
  '122639':'Parag Parikh Flexi Cap',
  '118989':'HDFC Mid-Cap Opportunities',
  '113177':'Nippon India Small Cap',
  '120465':'ICICI Pru Bluechip',
  '119598':'SBI Contra Fund',
  '120716':'Quant Small Cap',
  '118834':'Mirae Asset Large Cap',
  '125497':'UTI Nifty 50 Index'
};
async function funds() {
  const out = {};
  for (const code of Object.keys(FUNDS)) {
    try {
      const r = await fetch('https://api.mfapi.in/mf/' + code);
      const j = await r.json();
      const d = j.data || [];
      if (d.length > 1) {
        const nav = +d[0].nav, prev = +d[1].nav;
        out[code] = { name: j.meta?.scheme_name || FUNDS[code],
                      nav, date: d[0].date,
                      c: +(((nav / prev) - 1) * 100).toFixed(2) };
      }
    } catch (e) { console.log('   fund skip ' + code); }
    await sleep(120);
  }
  console.log('   funds: ' + Object.keys(out).length + ' NAVs');
  return out;
}

/* ---------- main ---------- */
(async () => {
  console.log('FinDeck fetch starting…');
  const quotes = await batch(Object.keys(MAP));
  await tryNSE(quotes);
  deriveBullion(quotes);
  const mf = await funds();

  const now = new Date();
  const payload = {
    updated: now.toISOString(),
    updatedIST: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata',
                  dateStyle: 'medium', timeStyle: 'medium' }),
    source: 'Yahoo Finance (delayed) + mfapi.in' +
            (quotes.NIFTY50?.p && quotes.NEXT50 ? ' + NSE' : ''),
    count: Object.keys(quotes).length,
    quotes,
    funds: mf
  };

  // skip the commit entirely if nothing actually moved
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (JSON.stringify(old.quotes) === JSON.stringify(quotes) &&
        JSON.stringify(old.funds)  === JSON.stringify(mf)) {
      console.log('No change since last run — nothing written.');
      return;
    }
  } catch (e) { /* first run, file missing or invalid */ }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.log('Wrote ' + payload.count + ' quotes at ' + payload.updatedIST);
})();
