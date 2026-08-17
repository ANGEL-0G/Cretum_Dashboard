/* ═══════════════════════════════════════════════════════════════════════════
 * Noticias del portafolio — generador (Google News RSS + lista blanca)
 *
 * Para cada empresa del portafolio consulta el feed de Google Noticias (últimos
 * días), FILTRA a medios confiables (lista blanca) para evitar ruido/fake news,
 * y escribe public/data/company-news.json. El home/blog lo lee en el cliente.
 *
 * Sin API key, sin función de Vercel: lo corre un GitHub Action a diario y
 * commitea el JSON (mismo patrón que el blog semanal).
 * Local: `node scripts/gen-news.mjs`
 * ═══════════════════════════════════════════════════════════════════════════ */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'data');
const OUT = join(OUT_DIR, 'company-news.json');
const PER_COMPANY = 5;     // máx notas por empresa
const WINDOW = '10d';      // ventana de Google News (últimos N días)

// Empresas del portafolio (tabla companies). `q` = búsqueda afinada para las
// ambiguas (Bolt/Lime/Groq…). Se quitó "Diversified Fund" (agregado) y dups.
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

// Lista blanca de medios confiables (dominios). Solo pasa lo de estas fuentes.
const ALLOW = new Set([
  'reuters.com', 'bloomberg.com', 'wsj.com', 'ft.com', 'cnbc.com', 'apnews.com',
  'techcrunch.com', 'theverge.com', 'forbes.com', 'businessinsider.com', 'axios.com',
  'theinformation.com', 'arstechnica.com', 'wired.com', 'fortune.com', 'nytimes.com',
  'theguardian.com', 'engadget.com', 'venturebeat.com', 'marketwatch.com', 'barrons.com',
  'cnn.com', 'bbc.com', 'bbc.co.uk', 'economist.com', 'fastcompany.com', 'techradar.com',
  'nbcnews.com', 'cnet.com', 'seekingalpha.com', 'investors.com', 'yahoo.com', 'qz.com',
]);

// Nombres "bonitos" cuando el feed da el dominio pelón como fuente.
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
// Títulos que NO son noticias (páginas de cotización, perfiles, etc.).
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

// Traduce EN→ES con el endpoint gratis de Google Translate. Si falla, devuelve ''.
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
    if (!r.ok) { console.warn(`[news] ${c.name}: HTTP ${r.status}`); return []; }
    xml = await r.text();
  } catch (e) { console.warn(`[news] ${c.name}: ${e.message}`); return []; }

  const out = [];
  for (const raw of xml.split('<item>').slice(1)) {
    const srcM = raw.match(/<source url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/i);
    let domain = '';
    try { domain = new URL(srcM ? srcM[1] : '').hostname.replace(/^www\./, ''); } catch (e) {}
    if (!ALLOW.has(domain)) continue;                 // solo fuentes confiables
    const rawName = srcM ? decode(srcM[2]) : domain;
    const source = NAMES[domain] || rawName;
    let title = decode(tag(raw, 'title'));
    if (rawName && title.endsWith(' - ' + rawName)) title = title.slice(0, -(rawName.length + 3)).trim();
    const link = decode(tag(raw, 'link'));
    const pub = tag(raw, 'pubDate').trim();
    let published = pub;
    try { published = new Date(pub).toISOString(); } catch (e) {}
    if (!title || !link || title.length < 16 || JUNK.test(title)) continue;   // descarta basura
    out.push({ company: c.name, title, url: link, source, domain, published });
    if (out.length >= PER_COMPANY) break;
  }
  return out;
}

const all = [];
for (const c of COMPANIES) {
  const items = await fetchCompany(c);
  all.push(...items);
  console.log(`[news] ${c.name}: ${items.length}`);
  await new Promise(r => setTimeout(r, 250));         // amable con el feed
}

// Dedup por URL, orden por fecha desc.
const seen = new Set();
const items = all
  .filter(x => { if (seen.has(x.url)) return false; seen.add(x.url); return true; })
  .sort((a, b) => (b.published || '').localeCompare(a.published || ''));

// Resumen en español = titular traducido (fallback al inglés si falla la traducción).
for (const it of items) {
  it.title_es = (await translateES(it.title)) || it.title;
  await new Promise(r => setTimeout(r, 120));
}
console.log(`[news] traducidas ${items.filter(i => i.title_es !== i.title).length}/${items.length}`);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  count: items.length,
  companies: COMPANIES.map(c => c.name),
  items,
}, null, 0), 'utf8');
console.log(`[news] TOTAL ${items.length} notas de ${new Set(items.map(i => i.company)).size} empresas → ${OUT}`);
