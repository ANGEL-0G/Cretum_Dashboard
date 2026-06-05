/**
 * scripts/update_from_csv.mjs — actualiza investments desde un CSV
 *
 * UPDATE-only: empareja por (investor.name, series.name, company.name) y
 * sobrescribe campos numéricos. NO trunca, NO borra, NO inserta — así
 * preserva el FK con investment_distributions (las 1,792 filas que pobló
 * la pipeline de Altareturn).
 *
 * Las filas del CSV que no matchean ningún investment existente se
 * reportan al final del log (no se insertan automáticamente).
 *
 * Uso (PowerShell):
 *   $env:DATABASE_URL = "postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres"
 *   $env:CSV_PATH     = "C:\ruta\al\Respaldo MVP Data Base ...csv"
 *   $env:DRY_RUN      = "1"   # opcional: simula sin escribir
 *   npm run update-csv
 *
 * Si no defines CSV_PATH usa la ruta por defecto en tu Downloads.
 */

import { readFileSync, existsSync } from 'node:fs';
import * as XLSX from 'xlsx';
import pg from 'pg';

const DEFAULT_CSV = String.raw`C:\Users\Angel Oliveros Cretu\Downloads\Respaldo MVP Data Base  - MVP DATA BASE 2025.csv`;
const CSV_PATH = process.env.CSV_PATH || DEFAULT_CSV;
const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.env.DRY_RUN === '1';

if (!DATABASE_URL) {
  console.error('ERROR: define DATABASE_URL antes de correr el script');
  process.exit(1);
}
if (!existsSync(CSV_PATH)) {
  console.error(`ERROR: no encuentro el CSV en ${CSV_PATH}`);
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

// "6%" → 0.06, "7.50%" → 0.075, "-" o "" → null. Decimal fraction.
const pct = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (!t || t === '-' || ['NA', 'N/A'].includes(t.toUpperCase())) return null;
  const cleaned = t.replace(/[%\s,]/g, '');
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return null;
  return num / 100;
};

// Normaliza keys de un row del CSV (trim) para tolerar headers con espacios.
function normRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k.trim()] = v;
  return out;
}

const sharesValue = (raw) => {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'public') return null;
  return n(raw);
};

async function main() {
  console.log(`Leyendo: ${CSV_PATH}`);
  if (DRY_RUN) console.log('⚠️  DRY_RUN activo — no se escribirá nada\n');

  const wb = XLSX.read(readFileSync(CSV_PATH), { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null });
  const rows = rawRows.map(normRow);
  console.log(`  ${rows.length} filas en CSV\n`);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  // Lookup maps: trim + lowercase para tolerar variaciones de formato.
  const { rows: invs }    = await client.query('SELECT id, name FROM investors');
  const { rows: cmps }    = await client.query('SELECT id, name FROM companies');
  const { rows: srs }     = await client.query('SELECT id, name FROM series');
  const norm = (x) => String(x).trim().toLowerCase();
  const invByName = new Map(invs.map(r => [norm(r.name), r.id]));
  const cmpByName = new Map(cmps.map(r => [norm(r.name), r.id]));
  const serByName = new Map(srs.map(r => [norm(r.name), r.id]));

  let updated = 0;
  let unchanged = 0;
  const unmatched = [];

  try {
    await client.query('BEGIN');

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const investor   = s(row['Investor']);
      const seriesName = s(row['Series']);
      const company    = s(row['Company']);

      if (!investor || !seriesName || !company) {
        unmatched.push({ idx: i + 2, reason: 'campos clave faltantes' });
        continue;
      }

      const invId = invByName.get(norm(investor));
      const serId = serByName.get(norm(seriesName));
      const cmpId = cmpByName.get(norm(company));
      if (!invId || !serId || !cmpId) {
        unmatched.push({
          idx: i + 2, reason: 'lookup falló',
          investor, series: seriesName, company,
          missing: [!invId && 'investor', !serId && 'series', !cmpId && 'company'].filter(Boolean),
        });
        continue;
      }

      const params = [
        n(row['Entry EV ($B)']),
        n(row['Entry PPS']),
        n(row['Current EV']),
        n(row['Current EV PPS']),
        sharesValue(row['Shares']),
        n(row['Commitment']),
        n(row['Commitment Actual']),
        n(row['DPI / MOIC']),
        pct(row['Carry']),
        invId, serId, cmpId,
      ];

      const { rowCount } = await client.query(
        `UPDATE investments SET
           entry_ev_b        = $1,
           entry_pps         = $2,
           current_ev_b      = $3,
           current_ev_pps    = $4,
           shares            = $5,
           commitment        = $6,
           commitment_actual = $7,
           dpi_moic          = $8,
           carry_pct         = $9,
           updated_at        = NOW()
         WHERE investor_id = $10 AND series_id = $11 AND company_id = $12`,
        params
      );

      if (rowCount === 0) {
        unmatched.push({
          idx: i + 2, reason: 'investments row no encontrada',
          investor, series: seriesName, company,
        });
      } else {
        updated += rowCount;
      }
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\n[DRY_RUN] ROLLBACK ejecutado — la BD quedó sin cambios.');
    } else {
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }

  console.log('\nRESULTADO:');
  console.log(`  Filas CSV procesadas:  ${rows.length}`);
  console.log(`  Investments updated:   ${updated}`);
  console.log(`  Sin match (saltadas):  ${unmatched.length}`);

  if (unmatched.length) {
    const reasons = {};
    unmatched.forEach(u => { reasons[u.reason] = (reasons[u.reason] || 0) + 1; });
    console.log('  Razones:', reasons);
    console.log('\n  Primeras 15 filas sin match:');
    unmatched.slice(0, 15).forEach(u => {
      const miss = u.missing ? ` (faltan: ${u.missing.join(', ')})` : '';
      console.log(`    fila ${u.idx}: ${u.reason}${miss}`);
      if (u.investor) console.log(`      → ${u.investor} / ${u.series} / ${u.company}`);
    });
    if (unmatched.length > 15) console.log(`    ... y ${unmatched.length - 15} más`);
  }
}

main().catch((err) => {
  console.error('FALLO:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
