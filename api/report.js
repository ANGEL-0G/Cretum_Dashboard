/**
 * api/report.js — Vercel Serverless Function
 * Genera el PDF del reporte de portafolio (HTML→PDF con chromium headless).
 *
 * POST /api/report  body = { meta, totals, pos }  (ver report-template.js)
 * → responde application/pdf
 *
 * Render: @sparticuz/chromium + puppeteer-core. Fuentes embebidas (data URIs)
 * desde api/_lib/fonts (incluidas vía vercel.json config.includeFiles).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { buildReportHtml } from './_lib/report-template.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// @font-face con las TTF en base64 (una sola vez por instancia)
let _fontFaces = null;
function fontFaces() {
  if (_fontFaces) return _fontFaces;
  const dir = path.join(__dirname, '_lib', 'fonts');
  const defs = [
    ['Outfit', 400, 'Outfit-Regular.ttf'],
    ['Outfit', 700, 'Outfit-Bold.ttf'],
    ['Instrument', 400, 'InstrumentSans-Regular.ttf'],
    ['Instrument', 700, 'InstrumentSans-Bold.ttf'],
    ['Geist', 400, 'GeistMono-Regular.ttf'],
  ];
  _fontFaces = defs.map(([fam, wt, file]) => {
    const b64 = fs.readFileSync(path.join(dir, file)).toString('base64');
    return `@font-face{font-family:'${fam}';font-weight:${wt};src:url(data:font/ttf;base64,${b64}) format('truetype');}`;
  }).join('\n');
  return _fontFaces;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end('method not allowed'); return; }
  let payload = req.body;
  try { if (typeof payload === 'string') payload = JSON.parse(payload); } catch { /* noop */ }
  if (!payload || !payload.pos || !payload.totals || !payload.meta) { res.status(400).end('bad payload'); return; }

  let browser;
  try {
    const html = buildReportHtml(payload, fontFaces());
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 816, height: 1056 },
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    await browser.close(); browser = null;

    const fname = (payload.meta.filename || 'reporte_portafolio') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.status(200).send(Buffer.from(pdf));
  } catch (e) {
    if (browser) { try { await browser.close(); } catch { /* noop */ } }
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
