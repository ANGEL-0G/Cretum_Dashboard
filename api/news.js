/**
 * api/news.js — Noticias del portafolio (MVP) y de seguimiento (Cretum).
 *
 * DOS modos en un endpoint:
 *  · CRON (Authorization: Bearer $CRON_SECRET, lo dispara Vercel cada hora):
 *    consulta Google News (filtrado a medios confiables), traduce el titular y
 *    guarda el resultado en Redis (news:mvp / news:cretum). NO commitea al repo
 *    — por eso vive en Vercel y no en GitHub Actions.
 *  · PÚBLICO (GET ?org=mvp|cretum): devuelve el JSON guardado en Redis. Lo leen
 *    el blog (/blog, /noticias-cretum) y el widget del home.
 *
 * Sustituye al viejo scripts/gen-news.mjs + workflow news.yml (que commiteaban
 * public/data/company-news*.json).
 */

import crypto from 'crypto';
import { getRedis } from './_lib/redis.js';

export const config = { maxDuration: 300 };   // el ciclo de fetch+traducción tarda ~1 min

const PER_COMPANY = 5;
const WINDOW = '10d';

// Portafolio MVP (tabla companies).
const COMPANIES = [
  { name: 'SpaceX', q: 'SpaceX' },
  { name: 'Anthropic', q: 'Anthropic (Claude AI)' },
  { name: 'Airbnb', q: 'Airbnb' },
  { name: 'Epic Games', q: '"Epic Games"' },
  { name: 'Groq', q: 'Groq AI chips' },
  { name: 'Klarna', q: 'Klarna' },
  { name: 'Revolut', q: 'Revolut' },
  { name: 'Rappi', q: 'Rappi' },
  { name: 'Bolt', q: 'Bolt fintech company' },
  { name: 'Agility Robotics', q: '"Agility Robotics"' },
  { name: 'Instacart', q: 'Instacart' },
  { name: 'Cohere', q: 'Cohere AI' },
  { name: 'Spotify', q: 'Spotify' },
  { name: 'Coinbase', q: 'Coinbase' },
  { name: 'Palantir', q: 'Palantir' },
  { name: 'Pinterest', q: 'Pinterest' },
  { name: 'SoFi', q: 'SoFi' },
  { name: 'DraftKings', q: 'DraftKings' },
  { name: 'Kraken', q: 'Kraken crypto exchange' },
  { name: 'Figure AI', q: '"Figure AI" robotics' },
  { name: 'Lime', q: 'Lime scooters micromobility' },
  { name: 'Diamond Foundry', q: '"Diamond Foundry"' },
  { name: 'Base Power', q: '"Base Power" energy startup' },
  { name: 'Mach Industries', q: '"Mach Industries"' },
  { name: 'Automattic', q: 'Automattic WordPress' },
  { name: 'Rent the Runway', q: '"Rent the Runway"' },
  { name: 'Udemy', q: 'Udemy' },
  { name: 'Patreon', q: 'Patreon' },
  { name: 'Asana', q: 'Asana software' },
  { name: 'Lyft', q: 'Lyft' },
];

// Empresas / temas de seguimiento de Cretum (distintas al portafolio; puede haber traslape).
const CRETUM_COMPANIES = [
  { name: 'NVIDIA', q: 'Nvidia' },
  { name: 'Base Power', q: '"Base Power" energy startup' },
  { name: 'Saronic', q: 'Saronic Technologies defense maritime' },
  { name: 'Cohesity', q: 'Cohesity' },
  { name: 'Kraken', q: 'Kraken crypto exchange' },
  { name: 'Diamond Foundry', q: '"Diamond Foundry"' },
  { name: 'Anthropic', q: 'Anthropic (Claude AI)' },
  { name: 'Bloomberg', q: 'Bloomberg LP company' },
  { name: 'Harley-Davidson', q: '"Harley-Davidson"' },
  { name: 'Constellation Brands', q: '"Constellation Brands"' },
  { name: 'Berkshire Hathaway', q: '"Berkshire Hathaway"' },
  { name: "Campbell's", q: '"Campbell Soup Company"' },
  { name: 'Valmer', q: 'Grupo Valmer' },
];

const ALLOW = new Set([
  'reuters.com', 'bloomberg.com', 'wsj.com', 'ft.com', 'cnbc.com', 'apnews.com',
  'techcrunch.com', 'theverge.com', 'forbes.com', 'businessinsider.com', 'axios.com',
  'theinformation.com', 'arstechnica.com', 'wired.com', 'fortune.com', 'nytimes.com',
  'theguardian.com', 'engadget.com', 'venturebeat.com', 'marketwatch.com', 'barrons.com',
  'cnn.com', 'bbc.com', 'bbc.co.uk', 'economist.com', 'fastcompany.com', 'techradar.com',
  'nbcnews.com', 'cnet.com', 'seekingalpha.com', 'investors.com', 'yahoo.com', 'qz.com',
]);
const NAMES = {
  'bloomberg.com': 'Bloomberg', 'forbes.com': 'Forbes', 'yahoo.com': 'Yahoo Finance',
  'reuters.com': 'Reuters', 'cnbc.com': 'CNBC', 'wsj.com': 'The Wall Street Journal',
  'ft.com': 'Financial Times', 'apnews.com': 'Associated Press', 'nytimes.com': 'The New York Times',
  'theguardian.com': 'The Guardian', 'businessinsider.com': 'Business Insider',
  'seekingalpha.com': 'Seeking Alpha', 'marketwatch.com': 'MarketWatch', 'barrons.com': "Barron's",
  'cnn.com': 'CNN', 'bbc.com': 'BBC', 'bbc.co.uk': 'BBC', 'economist.com': 'The Economist',
  'techcrunch.com': 'TechCrunch', 'theverge.com': 'The Verge', 'wired.com': 'WIRED',
  'arstechnica.com': 'Ars Technica', 'engadget.com': 'Engadget', 'venturebeat.com': 'VentureBeat',
  'axios.com': 'Axios', 'fortune.com': 'Fortune', 'fastcompany.com': 'Fast Company',
  'techradar.com': 'TechRadar', 'nbcnews.com': 'NBC News', 'cnet.com': 'CNET', 'qz.com': 'Quartz',
  'investors.com': "Investor's Business Daily", 'theinformation.com': 'The Information',
};
const JUNK = /(stock quote|price and forecast|quote & chart|share price|stock price|company profile|symbol__|_symbol|quote and chart|price target)/i;

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}
async function translateES(text) {
  if (!text) return '';
  try {
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t&q=' + encodeURIComponent(text);
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return '';
    const j = await r.json();
    return (j[0] || []).map(x => x[0]).join('').trim();
  } catch (e) { return ''; }
}
async function fetchCompany(c) {
  const q = encodeURIComponent(`${c.q} when:${WINDOW}`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  let xml = '';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CretumDesk/1.0)' } });
    if (!r.ok) return [];
    xml = await r.text();
  } catch (e) { return []; }
  const out = [];
  for (const raw of xml.split('<item>').slice(1)) {
    const srcM = raw.match(/<source url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/i);
    let domain = '';
    try { domain = new URL(srcM ? srcM[1] : '').hostname.replace(/^www\./, ''); } catch (e) {}
    if (!ALLOW.has(domain)) continue;
    const rawName = srcM ? decode(srcM[2]) : domain;
    const source = NAMES[domain] || rawName;
    let title = decode(tag(raw, 'title'));
    if (rawName && title.endsWith(' - ' + rawName)) title = title.slice(0, -(rawName.length + 3)).trim();
    const link = decode(tag(raw, 'link'));
    const pub = tag(raw, 'pubDate').trim();
    let published = pub;
    try { published = new Date(pub).toISOString(); } catch (e) {}
    if (!title || !link || title.length < 16 || JUNK.test(title)) continue;
    out.push({ company: c.name, title, url: link, source, domain, published });
    if (out.length >= PER_COMPANY) break;
  }
  return out;
}

// Genera el set completo (fetch + dedup + traducción) para una lista de empresas.
async function generate(companies) {
  const all = [];
  for (const c of companies) {
    all.push(...await fetchCompany(c));
    await new Promise(r => setTimeout(r, 200));
  }
  const seen = new Set();
  const items = all
    .filter(x => { if (seen.has(x.url)) return false; seen.add(x.url); return true; })
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  for (const it of items) {
    it.title_es = (await translateES(it.title)) || it.title;
    await new Promise(r => setTimeout(r, 100));
  }
  return items;
}
function blob(items, companies) {
  return { generated: new Date().toISOString(), count: items.length, companies: companies.map(c => c.name), items };
}

function bearer(req) { return String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); }
function safeEq(a, b) {
  const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
const EMPTY = JSON.stringify({ generated: null, count: 0, companies: [], items: [] });

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const isCron = !!(secret && safeEq(bearer(req), secret));

  // ── Modo CRON: regenerar y guardar en Redis (lo dispara Vercel cada hora) ──
  if (req.query.cron != null || isCron) {
    if (!isCron) return res.status(401).json({ error: 'No autorizado' });
    const r = getRedis();
    if (!r) return res.status(500).json({ error: 'Sin Redis' });
    const [mvp, cretum] = [await generate(COMPANIES), await generate(CRETUM_COMPANIES)];
    await r.set('news:mvp', JSON.stringify(blob(mvp, COMPANIES)));
    await r.set('news:cretum', JSON.stringify(blob(cretum, CRETUM_COMPANIES)));
    return res.status(200).json({ ok: true, mvp: mvp.length, cretum: cretum.length });
  }

  // ── Modo PÚBLICO: servir el JSON guardado (lo leen blog y widget) ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET requerido' });
  const org = req.query.org === 'cretum' ? 'cretum' : 'mvp';
  const r = getRedis();
  let raw = null;
  try { raw = r ? await r.get('news:' + org) : null; } catch (e) {}
  // Semilla: mientras el cron no haya poblado Redis (p. ej. recién desplegado),
  // sirve el último JSON estático commiteado para no mostrar la sección vacía.
  if (!raw) {
    try {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (host) {
        const f = await fetch(`https://${host}/data/company-news${org === 'cretum' ? '-cretum' : ''}.json`);
        if (f.ok) raw = await f.text();
      }
    } catch (e) {}
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  return res.status(200).send(raw || EMPTY);
}
