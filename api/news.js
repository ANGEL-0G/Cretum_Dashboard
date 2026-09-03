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
  { name: 'Agility Robotics', q: '"Agility Robotics"', w: '120d' },
  { name: 'Instacart', q: 'Instacart' },
  { name: 'Cohere', q: 'Cohere AI' },
  { name: 'Spotify', q: 'Spotify' },
  { name: 'Coinbase', q: 'Coinbase' },
  { name: 'Palantir', q: 'Palantir' },
  { name: 'Pinterest', q: 'Pinterest' },
  { name: 'SoFi', q: 'SoFi' },
  { name: 'DraftKings', q: 'DraftKings' },
  { name: 'Kraken', q: 'Kraken crypto exchange' },
  { name: 'Figure AI', q: '"Figure AI" robotics', w: '120d' },
  { name: 'Lime', q: 'Lime scooters micromobility', w: '120d' },
  { name: 'Diamond Foundry', q: '"Diamond Foundry"', w: '120d' },
  { name: 'Base Power', q: '"Base Power" energy startup', w: '120d' },
  { name: 'Mach Industries', q: '"Mach Industries"', w: '120d' },
  { name: 'Automattic', q: 'Automattic WordPress', w: '120d' },
  { name: 'Rent the Runway', q: '"Rent the Runway"' },
  { name: 'Udemy', q: 'Udemy', w: '120d' },
  { name: 'Patreon', q: 'Patreon', w: '120d' },
  { name: 'Asana', q: 'Asana software' },
  { name: 'Lyft', q: 'Lyft' },
  // Empresas de los Fund Trackers (pestaña Empresas — sección de noticias por card)
  { name: 'RapidSOS', q: '"RapidSOS"', w: '120d' },
  { name: 'BlueVoyant', q: '"BlueVoyant"', w: '120d' },
  { name: 'Jobandtalent', q: '"Jobandtalent" OR "Job and Talent"', w: '120d' },
  { name: 'Platform Science', q: '"Platform Science"', w: '120d' },
  { name: 'Wefox', q: 'wefox insurtech', w: '120d' },
  { name: 'HawkEye 360', q: '"HawkEye 360"', w: '120d' },
  { name: 'Trusted Health', q: '"Trusted Health" nursing', w: '120d' },
  { name: 'Forto', q: 'Forto logistics freight', w: '120d' },
  { name: 'Quantstamp', q: 'Quantstamp', w: '120d' },
  { name: 'Transfix', q: 'Transfix freight', w: '120d' },
  { name: 'Loft', q: '"Loft" Brazil real estate', w: '120d' },
  { name: 'Turo', q: 'Turo car sharing', w: '120d' },
  { name: 'IonQ', q: 'IonQ', w: '120d' },
  { name: 'Kodiak Robotics', q: '"Kodiak Robotics" OR "Kodiak AI"', w: '120d' },
  { name: 'Decart', q: '"Decart" AI', w: '120d' },
  { name: 'CHAOS Industries', q: '"CHAOS Industries"', w: '120d' },
  { name: 'Second Front', q: '"Second Front Systems"', w: '120d' },
  { name: 'Epirus', q: '"Epirus" defense', w: '120d' },
  { name: 'Radiant', q: '"Radiant" nuclear microreactor', w: '120d' },
  { name: 'Mythic', q: '"Mythic" AI chip', w: '120d' },
  { name: 'Cohesity', q: 'Cohesity', w: '120d' },
  { name: 'Saronic', q: 'Saronic Technologies', w: '120d' },
  { name: 'Amazegroup', q: '"Amazegroup" OR "Unikrn"', w: '365d' },
];

// Empresas / temas de seguimiento de Cretum (distintas al portafolio; puede haber traslape).
const CRETUM_COMPANIES = [
  { name: 'NVIDIA', q: 'Nvidia' },
  { name: 'Base Power', q: '"Base Power" energy startup', w: '120d' },
  { name: 'Saronic', q: 'Saronic Technologies defense maritime', w: '120d' },
  { name: 'Cohesity', q: 'Cohesity', w: '120d' },
  { name: 'Kraken', q: 'Kraken crypto exchange' },
  { name: 'Diamond Foundry', q: '"Diamond Foundry"', w: '120d' },
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
  // prensa especializada confiable (defensa/espacio/fintech/logística/robótica/salud/startups)
  'spacenews.com', 'defensenews.com', 'breakingdefense.com', 'defenseone.com', 'spaceflightnow.com',
  'geekwire.com', 'sifted.eu', 'tech.eu', 'eu-startups.com', 'finextra.com', 'pymnts.com',
  'americanbanker.com', 'freightwaves.com', 'supplychaindive.com', 'hrdive.com', 'healthcaredive.com',
  'fiercehealthcare.com', 'insurancejournal.com', 'coindesk.com', 'cointelegraph.com', 'theblock.co',
  'therobotreport.com', 'roboticsandautomationnews.com', 'constructiondive.com', 'utilitydive.com',
  // wires oficiales (anuncios de la propia empresa: funding, contratos, lanzamientos)
  'prnewswire.com', 'businesswire.com', 'globenewswire.com',
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
  'spacenews.com': 'SpaceNews', 'defensenews.com': 'Defense News', 'breakingdefense.com': 'Breaking Defense',
  'defenseone.com': 'Defense One', 'spaceflightnow.com': 'Spaceflight Now', 'geekwire.com': 'GeekWire',
  'sifted.eu': 'Sifted', 'tech.eu': 'Tech.eu', 'eu-startups.com': 'EU-Startups', 'finextra.com': 'Finextra',
  'pymnts.com': 'PYMNTS', 'americanbanker.com': 'American Banker', 'freightwaves.com': 'FreightWaves',
  'supplychaindive.com': 'Supply Chain Dive', 'hrdive.com': 'HR Dive', 'healthcaredive.com': 'Healthcare Dive',
  'fiercehealthcare.com': 'Fierce Healthcare', 'insurancejournal.com': 'Insurance Journal',
  'coindesk.com': 'CoinDesk', 'cointelegraph.com': 'Cointelegraph', 'theblock.co': 'The Block',
  'therobotreport.com': 'The Robot Report', 'roboticsandautomationnews.com': 'Robotics & Automation News',
  'constructiondive.com': 'Construction Dive', 'utilitydive.com': 'Utility Dive',
  'prnewswire.com': 'PR Newswire', 'businesswire.com': 'Business Wire', 'globenewswire.com': 'GlobeNewswire',
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
  const q = encodeURIComponent(`${c.q} when:${c.w || WINDOW}`);
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
// v2 2026-08-27: en LOTES PARALELOS — el ciclo serial con ~67 empresas rebasaba los
// 300s de maxDuration y el cron moría sin escribir a Redis (feed congelado).
async function generate(companies) {
  const all = [];
  for (let i = 0; i < companies.length; i += 8) {
    const chunk = companies.slice(i, i + 8);
    const res = await Promise.all(chunk.map(c => fetchCompany(c).catch(() => [])));
    res.forEach(r => all.push(...r));
    await new Promise(r => setTimeout(r, 150));
  }
  const seen = new Set();
  const items = all
    .filter(x => { if (seen.has(x.url)) return false; seen.add(x.url); return true; })
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  for (let i = 0; i < items.length; i += 10) {
    const chunk = items.slice(i, i + 10);
    await Promise.all(chunk.map(async it => {
      it.title_es = (await translateES(it.title)) || it.title;
    }));
    await new Promise(r => setTimeout(r, 80));
  }
  const logos = await companyLogos(companies);
  await enrichImages(items, logos);
  return items;
}
const UA = 'Mozilla/5.0 (compatible; CretumDesk/1.0; +https://cretumdesk.com)';

// ── Decodifica el enlace de Google News (redirección) a la URL real del medio ──
// Método batchexecute (2024+): 1) baja la página del artículo para sacar firma+timestamp,
// 2) los manda a Google y responde con la URL del editor. Si algo falla, devuelve el enlace
// original (og:image caerá y usaremos el logo del medio) — nunca rompe el cron.
async function resolveGoogleNews(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)news\.google\.com$/i.test(u.hostname)) return url;   // ya es del medio
    const parts = u.pathname.split('/');
    const gnId = parts[parts.indexOf('articles') + 1] || '';
    if (!gnId) return url;
    // 1) firma + timestamp desde la página del artículo
    const c1 = new AbortController(); const t1 = setTimeout(() => c1.abort(), 3500);
    const r1 = await fetch(url, { signal: c1.signal, headers: { 'User-Agent': UA } });
    clearTimeout(t1);
    const html = await r1.text();
    const sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
    const ts = (html.match(/data-n-a-ts="(\d+)"/) || [])[1];
    if (!sg || !ts) return url;
    // 2) batchexecute → URL real
    const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${gnId}",${ts},"${sg}"]`;
    const freq = JSON.stringify([[['Fbv4je', inner, null, 'generic']]]);
    const c2 = new AbortController(); const t2 = setTimeout(() => c2.abort(), 3500);
    const r2 = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST', signal: c2.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': UA },
      body: 'f.req=' + encodeURIComponent(freq),
    });
    clearTimeout(t2);
    const raw = await r2.text();
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (s[0] !== '[') continue;
      try {
        for (const e of JSON.parse(s)) {
          if (Array.isArray(e) && typeof e[2] === 'string' && e[2].indexOf('http') !== -1) {
            const arr = JSON.parse(e[2]);
            const found = (Array.isArray(arr) ? arr : []).find(x => typeof x === 'string' && /^https?:\/\//.test(x));
            if (found) return found;
          }
        }
      } catch (_) {}
    }
    return url;
  } catch (e) { return url; }
}

// ── Imágenes: og:image real del artículo (best-effort) con respaldo al logo del medio ──
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
async function fetchOgImage(url) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(to);
    if (!r.ok) return '';
    const html = (await r.text()).slice(0, 300000);
    let img = '';
    const pats = [
      /<meta[^>]+(?:property|name)=["'](?:og:image:secure_url|og:image:url|og:image|twitter:image:src|twitter:image)["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i,
      /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
    ];
    for (const p of pats) { const m = html.match(p); if (m) { img = m[1]; break; } }
    if (!img) {   // JSON-LD "image"
      const ld = html.match(/"image"\s*:\s*"([^"]+)"/i)
        || html.match(/"image"\s*:\s*\[\s*"([^"]+)"/i)
        || html.match(/"image"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/i);
      if (ld) img = ld[1];
    }
    img = decode(img || '').trim();
    if (img.startsWith('//')) img = 'https:' + img;
    else if (img.startsWith('/')) { try { img = new URL(img, url).href; } catch (e) {} }
    return /^https?:\/\//.test(img) ? img : '';
  } catch (e) { return ''; }
}
// ── Respaldo de imagen por EMPRESA: el LOGO de la marca vía Wikidata (propiedad P154).
//    Cuando el artículo no trae og:image, mostramos el logo de la empresa (p. ej.
//    Anthropic → su logo) en lugar de dejar la tarjeta sin foto. Se resuelve por la
//    PÁGINA EXACTA de Wikipedia (nada de búsqueda difusa, que caía en homónimos), de
//    ahí su entidad Wikidata y de ahí el logo oficial. Si no hay logo, devuelve ''
//    (la tarjeta queda como hoy) — nunca una imagen equivocada. ──
const WIKI = {   // override de título cuando el nombre no es el de la página de Wikipedia
  'NVIDIA': 'Nvidia', 'Palantir': 'Palantir Technologies', 'Bolt': 'Bolt Financial',
  'Bloomberg': 'Bloomberg L.P.', "Campbell's": 'Campbell Soup Company', 'Amazegroup': 'Unikrn',
  'Second Front': 'Second Front Systems', 'Base Power': 'Base Power Company', 'Valmer': 'Grupo Valmer',
  'Lime': 'Lime (transportation company)', 'Turo': 'Turo (company)', 'Kraken': 'Kraken (company)',
  'Asana': 'Asana (software)', 'Mythic': 'Mythic (company)', 'Loft': 'Loft (company)',
};
async function wikiImage(title) {
  try {
    const t = String(title || '').trim();
    if (!t) return '';
    // 1) página exacta → id de entidad Wikidata (Q…)
    const u1 = 'https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1'
      + '&prop=pageprops&ppprop=wikibase_item&titles=' + encodeURIComponent(t);
    const c1 = new AbortController(); const k1 = setTimeout(() => c1.abort(), 3500);
    const r1 = await fetch(u1, { signal: c1.signal, headers: { 'User-Agent': UA } });
    clearTimeout(k1);
    if (!r1.ok) return '';
    const j1 = await r1.json();
    const page = Object.values((j1 && j1.query && j1.query.pages) || {})[0];
    const qid = page && page.pageprops && page.pageprops.wikibase_item;
    if (!qid) return '';
    // 2) logo de la marca (P154) → archivo en Wikimedia Commons
    const u2 = 'https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&property=P154&entity=' + encodeURIComponent(qid);
    const c2 = new AbortController(); const k2 = setTimeout(() => c2.abort(), 3500);
    const r2 = await fetch(u2, { signal: c2.signal, headers: { 'User-Agent': UA } });
    clearTimeout(k2);
    if (!r2.ok) return '';
    const j2 = await r2.json();
    const claim = j2 && j2.claims && j2.claims.P154 && j2.claims.P154[0];
    const file = claim && claim.mainsnak && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value;
    if (!file) return '';
    return 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file) + '?width=640';
  } catch (e) { return ''; }
}
// Mapa empresa → logo de respaldo, cacheado en Redis (rara vez cambia): solo se
// consulta Wikidata para las empresas que aún no estén en el mapa. Para forzar un
// refresco (p. ej. una empresa que ya tenga logo), borra la clave news:logos.
async function companyLogos(companies) {
  const r = getRedis();
  let map = {};
  try { const raw = r ? await r.get('news:logos') : null; if (raw) map = JSON.parse(raw) || {}; } catch (e) {}
  const missing = companies.filter(c => !(c.name in map));
  for (let i = 0; i < missing.length; i += 6) {
    const chunk = missing.slice(i, i + 6);
    await Promise.all(chunk.map(async c => { map[c.name] = await wikiImage(WIKI[c.name] || c.name); }));
    await new Promise(res => setTimeout(res, 120));
  }
  try { if (r && missing.length) await r.set('news:logos', JSON.stringify(map)); } catch (e) {}
  return map;
}
// Enriquece las notas con imagen. Solo baja el HTML de las que se muestran (top),
// para no rebasar maxDuration; el resto usa directo la imagen de la empresa (sin fetch).
async function enrichImages(items, logos = {}) {
  const TOP = 24;
  const top = items.slice(0, TOP);
  for (let i = 0; i < top.length; i += 8) {
    const chunk = top.slice(i, i + 8);
    await Promise.all(chunk.map(async it => {
      const real = await resolveGoogleNews(it.url);   // enlace del medio (no el de Google)
      if (real && real !== it.url) it.url = real;      // "Leer" abre directo al editor
      const og = await fetchOgImage(it.url);
      if (og) { it.image = og; it.logo = false; }                        // foto real del artículo
      else { it.image = logos[it.company] || ''; it.logo = !!it.image; } // respaldo: imagen de la empresa
    }));
    await new Promise(r => setTimeout(r, 60));
  }
  // Las de más abajo no bajan HTML (tiempo), pero igual llevan la imagen de la empresa.
  for (const it of items.slice(TOP)) { it.image = logos[it.company] || ''; it.logo = !!it.image; }
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
    // Una corrida vacía (p. ej. Google News limitó la tanda) NO debe borrar el feed:
    // si no hubo items pero ya había datos guardados, se conservan los buenos.
    const saveNews = async (key, items, companies) => {
      if (items.length) { await r.set(key, JSON.stringify(blob(items, companies))); return; }
      const prev = await r.get(key);
      if (!prev) await r.set(key, JSON.stringify(blob(items, companies)));
    };
    const mvp = await generate(COMPANIES);
    await saveNews('news:mvp', mvp, COMPANIES);
    await new Promise(res => setTimeout(res, 4000));   // respiro para no encadenar el rate-limit de Google News en Cretum
    const cretum = await generate(CRETUM_COMPANIES);
    await saveNews('news:cretum', cretum, CRETUM_COMPANIES);
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
  // ¿El guardado está vacío (nulo o sin items, p. ej. una corrida del cron que
  // Google News limitó)? → caer a la semilla para no mostrar "No news yet".
  let needSeed = !raw;
  if (raw) { try { const j = JSON.parse(raw); if (!j || !(j.items || []).length) needSeed = true; } catch (e) { needSeed = true; } }
  // Semilla: mientras el cron no haya poblado Redis (p. ej. recién desplegado),
  // sirve el último JSON estático commiteado para no mostrar la sección vacía.
  if (needSeed) {
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
