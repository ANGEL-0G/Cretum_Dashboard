/**
 * Importer del Excel de inversionistas a Supabase.
 * Reescritura en Node.js del script original (que estaba en Python).
 *
 * Uso (PowerShell):
 *   $env:DATABASE_URL = "postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres"
 *   $env:XLSX_PATH    = "C:\Users\Angel Oliveros Cretu\Documents\Cretum\Proyecto BD\data\Cretum_MVP LP Tracking Sheet.xlsx"
 *   npm run import
 *
 * Si no defines XLSX_PATH usa la ruta por defecto del Excel local.
 */

import { readFileSync, existsSync } from 'node:fs';
import * as XLSX from 'xlsx';
import pg from 'pg';

const DEFAULT_XLSX = String.raw`C:\Users\Angel Oliveros Cretu\Documents\Cretum\Proyecto BD\data\Cretum_MVP LP Tracking Sheet.xlsx`;
const XLSX_PATH = process.env.XLSX_PATH || DEFAULT_XLSX;
const SHEET = 'MVP Data Base 2026';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: define la env var DATABASE_URL antes de correr el script');
  process.exit(1);
}
if (!existsSync(XLSX_PATH)) {
  console.error(`ERROR: no encuentro el Excel en ${XLSX_PATH}`);
  process.exit(1);
}

const s = (v) => {
  if (v === null || v === undefined) return null;
  const out = String(v).trim();
  return out === '' ? null : out;
};

const n = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = String(v).trim();
  if (t === '' || ['NA', 'N/A', '-'].includes(t.toUpperCase())) return null;
  const cleaned = t.replace(/[\$,\s]/g, '');
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
};

const isPublicFlag = (v) => {
  const val = s(v);
  if (val === null) return null;
  return val.toLowerCase().startsWith('public');
};

async function main() {
  console.log(`Leyendo: ${XLSX_PATH}`);
  const wb = XLSX.read(readFileSync(XLSX_PATH), { type: 'buffer' });
  if (!wb.SheetNames.includes(SHEET)) {
    console.error(`ERROR: no encuentro la hoja "${SHEET}". Hojas disponibles: ${wb.SheetNames.join(', ')}`);
    process.exit(1);
  }
  const ws = wb.Sheets[SHEET];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  console.log(`  ${rows.length} filas en hoja "${SHEET}"\n`);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const invCache = new Map();
  const compCache = new Map();
  const seriesCache = new Map();
  const contactsSeen = new Set();
  let insertedInvs = 0;
  const skipped = [];

  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE contacts, investments RESTART IDENTITY');

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const investor = s(row['Investor']);
      const seriesName = s(row['Series']);
      const company = s(row['Company ']); // ojo: hay espacio al final en el header del Excel
      const pub = isPublicFlag(row['Public/ Private']);

      if (!investor || !seriesName || !company || pub === null) {
        skipped.push({ idx: i, reason: 'campo clave faltante' });
        continue;
      }

      // Investor
      if (!invCache.has(investor)) {
        const r = await client.query(
          `INSERT INTO investors (name) VALUES ($1)
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [investor]
        );
        invCache.set(investor, r.rows[0].id);
      }
      const invId = invCache.get(investor);

      // Contact (uno por investor, el primero que aparezca)
      const contactName = s(row['Nombre']);
      const contactMail = s(row['Mail']);
      if ((contactName || contactMail) && !contactsSeen.has(invId)) {
        await client.query(
          'INSERT INTO contacts (investor_id, name, email) VALUES ($1, $2, $3)',
          [invId, contactName || '(sin nombre)', contactMail]
        );
        contactsSeen.add(invId);
      }

      // Company
      if (!compCache.has(company)) {
        const r = await client.query(
          `INSERT INTO companies (name, is_public) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET is_public = EXCLUDED.is_public
           RETURNING id`,
          [company, pub]
        );
        compCache.set(company, r.rows[0].id);
      }
      const compId = compCache.get(company);

      // Series
      if (!seriesCache.has(seriesName)) {
        const r = await client.query(
          `INSERT INTO series (name, company_id) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET company_id = EXCLUDED.company_id
           RETURNING id`,
          [seriesName, compId]
        );
        seriesCache.set(seriesName, r.rows[0].id);
      }
      const serId = seriesCache.get(seriesName);

      // Shares: si dice "public" en string, dejar null
      const sharesRaw = row['Shares'];
      let sharesVal = null;
      if (sharesRaw !== null && sharesRaw !== undefined && sharesRaw !== '') {
        if (typeof sharesRaw === 'string' && sharesRaw.trim().toLowerCase() === 'public') {
          sharesVal = null;
        } else {
          sharesVal = n(sharesRaw);
        }
      }

      await client.query(
        `INSERT INTO investments (
           investor_id, series_id, company_id,
           entry_ev_b, entry_pps, current_ev_b, current_ev_pps,
           shares, commitment, commitment_actual, dpi_moic, carry_pct
         ) VALUES ($1,$2,$3, $4,$5,$6,$7, $8,$9,$10,$11,$12)`,
        [
          invId, serId, compId,
          n(row['Entry EV ($B)']),
          n(row['Entry PPS']),
          n(row['Current EV']),
          n(row['Current EV PPS']),
          sharesVal,
          n(row['Commitment']),
          n(row['Commitment Actual']),
          n(row['DPI / MOIC']),
          null,
        ]
      );
      insertedInvs++;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }

  console.log('RESULTADO:');
  console.log(`  Investors unicos:       ${invCache.size}`);
  console.log(`  Companies unicas:       ${compCache.size}`);
  console.log(`  Series unicas:          ${seriesCache.size}`);
  console.log(`  Contactos creados:      ${contactsSeen.size}`);
  console.log(`  Investments insertadas: ${insertedInvs}`);
  console.log(`  Filas saltadas:         ${skipped.length}`);
  if (skipped.length) {
    const reasons = {};
    skipped.forEach(({ reason }) => { reasons[reason] = (reasons[reason] || 0) + 1; });
    console.log(`  Razones: ${JSON.stringify(reasons)}`);
    skipped.slice(0, 5).forEach(({ idx, reason }) =>
      console.log(`    fila ${idx + 2} (1-indexed con header): ${reason}`)
    );
  }
}

main().catch((err) => {
  console.error('FALLO:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
