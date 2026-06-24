/**
 * api/report.js — Vercel Serverless Function
 * Genera el PDF del reporte de portafolio (HTML→PDF con chromium headless).
 * POST /api/report  body = { meta, totals, pos }  → application/pdf
 * GET  /api/report  → health check (JSON), para diagnóstico.
 *
 * Todos los imports pesados son DINÁMICOS dentro del try, para poder reportar
 * cualquier fallo como JSON 500 en vez de FUNCTION_INVOCATION_FAILED.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).json({ alive: true, node: process.version, region: process.env.VERCEL_REGION || null });
    return;
  }
  let payload = req.body;
  try { if (typeof payload === 'string') payload = JSON.parse(payload); } catch { /* noop */ }
  if (!payload || !payload.pos || !payload.totals || !payload.meta) { res.status(400).json({ error: 'bad payload' }); return; }

  let browser;
  try {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const { buildReportHtml } = await import('./_lib/report-template.js');
    const chromium = (await import('@sparticuz/chromium')).default;
    const puppeteer = (await import('puppeteer-core')).default;

    const dir = path.dirname(fileURLToPath(import.meta.url)) + '/_lib/fonts';
    const fontFaces = [
      ['Outfit', 400, 'Outfit-Regular.ttf'], ['Outfit', 700, 'Outfit-Bold.ttf'],
      ['Instrument', 400, 'InstrumentSans-Regular.ttf'], ['Instrument', 700, 'InstrumentSans-Bold.ttf'],
      ['Geist', 400, 'GeistMono-Regular.ttf'],
    ].map(([fam, wt, file]) => {
      const b64 = fs.readFileSync(path.join(dir, file)).toString('base64');
      return `@font-face{font-family:'${fam}';font-weight:${wt};src:url(data:font/ttf;base64,${b64}) format('truetype');}`;
    }).join('\n');

    const html = buildReportHtml(payload, fontFaces);
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 816, height: 1056 },
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    const pdf = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
    await browser.close(); browser = null;

    const fname = (payload.meta.filename || 'reporte_portafolio') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.status(200).send(Buffer.from(pdf));
  } catch (e) {
    if (browser) { try { await browser.close(); } catch { /* noop */ } }
    res.status(500).json({ error: String(e && e.message || e), stack: String(e && e.stack || '').split('\n').slice(0, 6) });
  }
}
