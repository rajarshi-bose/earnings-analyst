// Earnings Report Qualitative Analyst: data service
// A Cloudflare Worker that fetches public data the browser cannot reach directly
// (SEC EDGAR and price feeds do not allow cross-site requests from a web page).
//
// Routes (all GET, all JSON):
//   /companies                         S&P 500 companies with SEC CIK numbers
//   /filings?ticker=AAPL               earnings releases (8-K, item 2.02) with quarter dates
//   /report?cik=320193&acc=0000320193-26-000005
//                                      the earnings press release HTML (exhibit 99.1)
//   /prices?symbol=AAPL&from=2026-01-01&to=2026-06-30
//                                      daily closes, split and dividend adjusted
//   /news?q=Apple&ticker=AAPL&from=2026-06-28&to=2026-11-05
//                                      headlines about the company in that window (Google News)
//
// Set CONTACT_EMAIL in wrangler.toml: the SEC asks every automated client to name a contact.

const ALLOWED_ORIGINS = [/^https:\/\/jarsh\.us$/, /^https:\/\/rajarshi-bose\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

const HOUR = 3600;
const DAY = 24 * HOUR;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "Only GET is supported." }, 405, cors);

    const url = new URL(request.url);
    const ua = `jarsh.us earnings analyst (${env.CONTACT_EMAIL || "contact not set"})`;

    try {
      // Cache every successful answer at the edge so repeat visits do not hit the SEC again.
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) return withCors(hit, cors);

      let body, ttl;
      switch (url.pathname.replace(/\/+$/, "")) {
        case "/companies": body = await companies(ua); ttl = DAY; break;
        case "/filings": body = await filings(url, ua); ttl = 6 * HOUR; break;
        case "/report": body = await report(url, ua); ttl = 30 * DAY; break;
        case "/prices": ({ body, ttl } = await prices(url)); break;
        case "/news": ({ body, ttl } = await news(url)); break;
        case "": return json({ ok: true, routes: ["/companies", "/filings", "/report", "/prices", "/news"] }, 200, cors);
        default: return json({ error: "Unknown route." }, 404, cors);
      }

      const res = json(body, 200, { "Cache-Control": `public, max-age=${ttl}` });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return withCors(res, cors);
    } catch (err) {
      const status = err.status || 502;
      return json({ error: err.message || "Something went wrong reaching the data source." }, status, cors);
    }
  },
};

/* ---------- companies ---------- */

async function companies(ua) {
  const [sp, sec] = await Promise.all([sp500(), secTickers(ua)]);
  const out = [];
  for (const c of sp) {
    const cik = sec.get(c.t);
    if (cik) out.push({ t: c.t, n: c.n, cik });
  }
  if (!out.length) throw httpError(502, "Could not load the S&P 500 list.");
  out.sort((a, b) => a.t.localeCompare(b.t));
  return { updated: new Date().toISOString().slice(0, 10), companies: out };
}

// Current constituents from the Wikipedia list (kept up to date as the index changes).
async function sp500() {
  const res = await fetch("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", {
    headers: { "User-Agent": "jarsh.us earnings analyst (https://jarsh.us)" },
  });
  if (!res.ok) throw httpError(502, "Could not load the S&P 500 list.");
  const html = await res.text();
  const start = html.indexOf('id="constituents"');
  if (start < 0) throw httpError(502, "The S&P 500 list changed format.");
  const table = html.slice(start, html.indexOf("</table>", start));
  const rows = table.split(/<tr[\s>]/).slice(1);
  const out = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
    if (cells.length < 2) continue;
    const t = normTicker(cells[0]);
    if (t && cells[1]) out.push({ t, n: cells[1] });
  }
  return out;
}

async function secTickers(ua) {
  const res = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": ua } });
  if (!res.ok) throw httpError(502, "Could not reach SEC EDGAR.");
  const data = await res.json();
  const map = new Map();
  for (const k in data) map.set(normTicker(data[k].ticker), data[k].cik_str);
  return map;
}

/* ---------- filings ---------- */

async function filings(url, ua) {
  const ticker = normTicker(url.searchParams.get("ticker") || "");
  if (!ticker) throw httpError(400, "Enter a ticker.");
  const cik = (await secTickers(ua)).get(ticker);
  if (!cik) throw httpError(404, `No SEC filer found for ${ticker}.`);

  const res = await fetch(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`, {
    headers: { "User-Agent": ua },
  });
  if (!res.ok) throw httpError(502, "Could not reach SEC EDGAR.");
  const sub = await res.json();
  const r = sub.filings.recent;

  // Period-end dates of every quarterly and annual report. These mark the company's
  // own quarter boundaries, so odd fiscal calendars (late-October quarters and so on) stay exact.
  const periodEnds = [];
  for (let i = 0; i < r.form.length; i++) {
    if (/^10-[QK](\/A)?$/.test(r.form[i]) && r.reportDate[i]) periodEnds.push(r.reportDate[i]);
  }
  const ends = [...new Set(periodEnds)].sort();

  const releases = [];
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] !== "8-K" || !/\b2\.02\b/.test(r.items[i] || "")) continue;
    const filed = r.filingDate[i];
    // The quarter a release covers is the latest period end before it was filed (within 120 days).
    let periodEnd = null;
    for (const e of ends) if (e < filed && daysBetween(e, filed) <= 120) periodEnd = e;
    let estimated = false;
    if (!periodEnd) { periodEnd = calendarQuarterEndBefore(filed); estimated = true; }

    // The two quarters before the reported one, using the company's own reported period ends when known.
    const prior = ends.filter((e) => e < periodEnd && daysBetween(e, periodEnd) <= 290).slice(-3);
    const quarterStarts = [];
    let cursor = periodEnd;
    for (let k = 0; k < 3; k++) {
      const known = prior.filter((e) => e < cursor && daysBetween(e, cursor) >= 75 && daysBetween(e, cursor) <= 105).pop();
      cursor = known || shiftMonths(cursor, -3);
      quarterStarts.push(cursor);
    }
    // quarterStarts: [end of Q-1, end of Q-2, end of Q-3]
    releases.push({
      acc: r.accessionNumber[i],
      filed,
      periodEnd,
      periodEstimated: estimated,
      priorEnds: quarterStarts,
    });
  }
  if (!releases.length) throw httpError(404, `No earnings releases found for ${ticker} in recent SEC filings.`);

  return { ticker, name: sub.name, cik, releases };
}

/* ---------- report ---------- */

async function report(url, ua) {
  const cik = (url.searchParams.get("cik") || "").replace(/^0+/, "");
  const acc = url.searchParams.get("acc") || "";
  if (!/^\d{1,10}$/.test(cik) || !/^\d{10}-\d{2}-\d{6}$/.test(acc)) throw httpError(400, "Bad filing reference.");
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}`;

  const idx = await fetch(`${base}/${acc}-index.htm`, { headers: { "User-Agent": ua } });
  if (!idx.ok) throw httpError(502, "Could not open the filing on SEC EDGAR.");
  const html = await idx.text();

  // Each document row: description, link, type (EX-99.1 is the press release), size.
  const docs = [];
  for (const row of html.split(/<tr[\s>]/).slice(1)) {
    const href = (row.match(/href="([^"]+)"/) || [])[1];
    if (!href) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
    const type = cells.find((c) => /^(EX-|8-K)/i.test(c)) || "";
    const size = Number((cells[cells.length - 1] || "").replace(/\D/g, "")) || 0;
    docs.push({ href: href.replace(/^\/ix\?doc=/, ""), type: type.toUpperCase(), size });
  }
  const isDoc = (d) => /\.html?$/i.test(d.href);
  const pick =
    docs.find((d) => isDoc(d) && d.type === "EX-99.1") ||
    docs.filter((d) => isDoc(d) && /^EX-99/.test(d.type)).sort((a, b) => b.size - a.size)[0] ||
    docs.find((d) => isDoc(d) && /ex-?99/i.test(d.href)) ||
    docs.find((d) => isDoc(d) && d.type === "8-K");
  if (!pick) throw httpError(404, "This filing has no readable press release.");

  const docUrl = new URL(pick.href, "https://www.sec.gov").toString();
  const doc = await fetch(docUrl, { headers: { "User-Agent": ua } });
  if (!doc.ok) throw httpError(502, "Could not open the press release.");
  let body = await doc.text();
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, "")
    .replace(/src="data:[^"]*"/gi, 'src=""');

  return { url: docUrl, type: pick.type || "8-K", html: body };
}

/* ---------- prices ---------- */

async function prices(url) {
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  if (!/^\^?[A-Z0-9.\-]{1,10}$/.test(symbol)) throw httpError(400, "Bad symbol.");
  if (!isDate(from) || !isDate(to) || from > to) throw httpError(400, "Bad date range.");

  let points = await yahoo(symbol.replace(/\./g, "-"), from, to).catch(() => null);
  if (!points || points.length < 2) points = await stooq(symbol, from, to).catch(() => null);
  if (!points || points.length < 2) throw httpError(502, `No price data found for ${symbol}.`);

  // A window that ended more than a few days ago never changes, so it can be cached for long.
  const settled = daysBetween(to, new Date().toISOString().slice(0, 10)) > 4;
  return { body: { symbol, points }, ttl: settled ? 30 * DAY : 6 * HOUR };
}

async function yahoo(sym, from, to) {
  const p1 = Math.floor(Date.parse(from + "T00:00:00Z") / 1000);
  const p2 = Math.floor(Date.parse(to + "T23:59:59Z") / 1000);
  const res = await fetch(
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; jarsh.us earnings analyst)" } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  if (!r?.timestamp) return null;
  const closes = r.indicators?.adjclose?.[0]?.adjclose || r.indicators?.quote?.[0]?.close || [];
  const out = [];
  r.timestamp.forEach((t, i) => {
    const c = closes[i];
    if (c != null && isFinite(c)) out.push([new Date(t * 1000).toISOString().slice(0, 10), round(c)]);
  });
  return out;
}

async function stooq(symbol, from, to) {
  const s = symbol === "^GSPC" ? "^spx" : symbol.toLowerCase().replace(/\./g, "-") + ".us";
  const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&d1=${from.replace(/-/g, "")}&d2=${to.replace(/-/g, "")}&i=d`);
  if (!res.ok) return null;
  const lines = (await res.text()).trim().split(/\r?\n/).slice(1);
  return lines
    .map((l) => l.split(","))
    .filter((c) => isDate(c[0]) && isFinite(+c[4]))
    .map((c) => [c[0], round(+c[4])]);
}

/* ---------- news ---------- */

async function news(url) {
  const q = (url.searchParams.get("q") || "").replace(/["<>]/g, "").trim().slice(0, 60);
  const ticker = normTicker(url.searchParams.get("ticker") || "");
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  if (!q) throw httpError(400, "Missing company name.");
  if (!isDate(from) || !isDate(to) || from > to || daysBetween(from, to) > 200) throw httpError(400, "Bad date range.");

  // One search per month, so results spread across the whole window instead of bunching at the end.
  const chunks = [];
  for (let a = from; a <= to; a = addDaysIso(a, 31)) {
    const b = addDaysIso(a, 31) > to ? addDaysIso(to, 1) : addDaysIso(a, 31);
    chunks.push([a, b]);
  }
  const query = (a, b) => `"${q}" (stock OR shares OR earnings OR revenue OR analysts) after:${a} before:${b}`;
  const lists = await Promise.all(chunks.map(([a, b]) => googleNews(query(a, b)).catch(() => [])));

  // Keep headlines inside the window that actually name the company, one copy of each.
  const name = q.toLowerCase().split(/\s+/)[0];
  const tick = ticker.replace(/-/g, ".").toLowerCase();
  const seen = new Set();
  const items = [];
  for (const it of lists.flat()) {
    if (it.date < from || it.date > to) continue;
    const t = it.title.toLowerCase();
    const named = new RegExp(`\\b${escapeRe(q.toLowerCase())}\\b`).test(t) || new RegExp(`\\b${escapeRe(name)}\\b`).test(t) || (tick.length > 1 && new RegExp(`\\b${escapeRe(tick)}\\b`).test(t));
    if (!named) continue;
    const key = t.replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(it);
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const settled = daysBetween(to, new Date().toISOString().slice(0, 10)) > 4;
  return { body: { q, from, to, source: "Google News", items: items.slice(0, 150) }, ttl: settled ? 7 * DAY : 3 * HOUR };
}

async function googleNews(query) {
  const res = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; jarsh.us earnings analyst)" },
  });
  if (!res.ok) return [];
  const xml = await res.text();
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (n) => { const x = m[1].match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`)); return x ? decode(x[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim() : ""; };
    const source = tag("source");
    let title = tag("title");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const d = new Date(tag("pubDate"));
    const link = tag("link");
    if (!title || isNaN(d) || !/^https:\/\//.test(link)) continue;
    out.push({ date: d.toISOString().slice(0, 10), title, source, link });
  }
  return out;
}

/* ---------- helpers ---------- */

function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.some((re) => re.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin : "https://jarsh.us",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
function withCors(res, cors) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function text(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;|&#160;/g, " ").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
}
function normTicker(t) { return String(t).trim().toUpperCase().replace(/\./g, "-").replace(/[^A-Z0-9\-]/g, ""); }
function addDaysIso(iso, k) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function decode(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
}
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function round(n) { return Math.round(n * 10000) / 10000; }
function shiftMonths(iso, m) {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + m);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
function calendarQuarterEndBefore(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const q = Math.floor(d.getUTCMonth() / 3); // current quarter index
  const end = new Date(Date.UTC(d.getUTCFullYear(), q * 3, 0)); // last day of previous quarter
  return end.toISOString().slice(0, 10);
}
