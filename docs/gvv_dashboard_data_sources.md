> ⚠ **DIRECTIVA 2026-08-08 (Eugenio): TODOS los datos salen EXCLUSIVAMENTE del Excel**
> ("Actualización Info GVV Dashboard.xlsx"). Los KPIs (MTD/YTD/AUM/CAGR5/acumulados,
> brutos y netos) ahora se leen de la hoja **General** (secciones GROSS y NET) — ya NO
> de la carta ni de fórmulas de anclaje. La carta mensual y la presentación son
> ÚNICAMENTE descargables (links). Checks del robot = consistencia interna del Excel;
> si el archivo se contradice: avisa por Telegram y ESPERA sin publicar.

# GVV Dashboard — de dónde sale cada dato (mapa fuente → campo)

Referencia para la actualización mensual del `public/gvv-detalle.html` (bundle standalone,
payload JSON dentro de `<script type="__bundler/template">`). Escrito tras el cierre de
**julio 2026** (corrida del 2026-08-06) para que la automatización sepa exactamente qué
documento gobierna qué campo, sin mezclar fuentes.

Hay 3 documentos de entrada, cada mes, y NO se pisan entre sí:

| Documento | Ruta en Dropbox | Gobierna |
|---|---|---|
| Excel maestro ("Actualización Info GVV Dashboard.xlsx") | `01 GVV/21. Automatización GVV/Actualización Info GVV Dashboard/` | `__G.D` completo (holdings/agregados/top10/privadas/opciones) + grids `__G.TRACK`/`__G.TRACKNET` |
| Carta mensual (PDF, "NN Cretum-Letter <Mes> <Año>.pdf") | `Marketing/Carta Mensual/<año>/` | `__G.METRICS` (cagr5, oneYr) — **fuente oficial, pisa al Excel si difieren** — y el link "Última carta mensual" |
| Presentación (2 PDFs, ES/EN, "Cretum GVV <Mes> <Año> Español/English.pdf") | `Marketing/Presentaciones GVV/` | **SOLO** el link "Presentación" en materiales. No toca ningún número del dashboard. |

## Convención de mes
El PDF llega los primeros días del mes siguiente reportando el mes que **acaba de cerrar**.
La corrida de hoy (2026-08-06) reporta **julio 2026** (no agosto — agosto ni ha cerrado).
El índice que se llena en los arrays `__G.TRACK["2026"]` / `__G.TRACKNET["2026"]` es el del
mes reportado (julio = índice 6, 0-based), nunca el mes calendario en que se corre el script.

## Campo por campo

### `__G.TRACK["<año>"][mes]` (rendimiento bruto mensual, %)
- **Fuente única:** Excel, hoja `Gross Returns ENG`, fila del año, columna del mes.
- Cruce (no sustituye): la carta trae "Last Month" en Performance Statistics — debe coincidir
  con este mismo valor. Julio: Excel `0.0061` = carta `0.61%`. Si no coinciden, hay un error
  de datos entre Kevin y la carta — parar y avisar, no promediar ni adivinar.

### `__G.TRACKNET["<año>"][mes]` (rendimiento neto mensual, %)
- **Fuente única:** Excel, hoja `Net Returns ENG`, misma fila/columna que arriba.
- La carta NO trae cifras netas (el disclaimer de la carta dice "gross fees unless otherwise
  noted") — este campo SIEMPRE sale del Excel, nunca hay con qué cruzarlo.

### `__G.METRICS.cagr5` (CAGR 5 años, bruto)
- **Fuente: la carta**, sección "Performance Statistics" → "5 Year CAGR". Julio: `14.76%`.
- El Excel también trae un "5Year Gross CAGR" en la hoja `General` (julio: `14.757%`) — casi
  idéntico, se usa solo como validación cruzada. Si la carta no está disponible, cae al Excel.

### `__G.METRICS.oneYr` (rendimiento últimos 12 meses, bruto)
- **Fuente: la carta**, "Last 12 Months". Julio: `36.83%`.
- ⚠ OJO: el Excel trae su PROPIO "1 Year Gross Cumulative Return" en la hoja `General`
  (julio: `37.76%`) que **no** coincide con la carta. Metodologías distintas (la carta usa NAV
  oficial del administrador; el Excel es una reconstrucción interna). **Manda la carta**,
  siempre — así se hizo en meses anteriores (jun-2026: carta 40.17% se usó, no el Excel).

### `__G.METRICS.cum5y` (cumulative return 5 años, bruto — dato "muerto", no se renderiza hoy)
- **No sale de ningún documento.** Se DERIVA: `(1+cagr5)^5 - 1`, usando el cagr5 de la carta.
- El Excel tiene un campo "Retorno compuesto últimos 5 años" (hoja `Gross Returns ENG`, fila
  resumen) que NO es consistente con su propio CAGR5 bajo compounding simple (julio: campo dice
  115.66% pero `(1.1476)^5-1` = ~99%) — no se usa, parece medir una ventana distinta. Si se
  reactiva este campo en la UI algún día, seguir derivándolo del cagr5, no leer ese campo del Excel.

### `cagr5Net` / `cum5yNet` / `oneYrNet` (versiones netas — "muertas", no se renderizan hoy)
- **Derivadas**, no leídas directo. Método: de los grids `Gross Returns ENG` / `Net Returns ENG`
  se calcula el factor de crecimiento compuesto de los últimos 12 y últimos 60 meses para bruto
  y neto por separado; `r12 = factor_neto_12m / factor_bruto_12m`, `r60` análogo a 60 meses.
  Luego se ancla al oficial de la carta: `oneYrNet = ((1+oneYr_carta)·r12 - 1)·100`,
  `cum5yNet = ((1+cum5y_derivado)·r60 - 1)·100`, `cagr5Net = (1+cum5yNet/100)^0.2 - 1`.
  (El Excel SÍ trae su propio "CAGR Últimos 5 años" neto, pero por consistencia con el método
  de meses anteriores se prefiere la razón anclada al oficial, no ese campo directo.)

### `__G.D` completo (holdings, `top10`, `privates`, `asset_class`/`strategy`/`geography`/`sector`, `options`, `total`/`total_pl`/etc.)
- **Fuente única: el Excel**, hojas `Equities` (holdings/privadas) y `Opciones`.
- La carta y la presentación NO tocan esta sección en absoluto.
- Reglas de reconstrucción descubiertas hoy (no están en ningún documento, son convención del
  equipo — hay que mantenerlas a mano en el script, no se infieren del Excel):
  - Sectores llegan truncados a 30 caracteres en la columna `Sector` — hay una tabla fija de
    restauración (ver script). Nuevo sector truncado que no esté en la tabla → completar con el
    nombre estándar GICS Industry Group y avisar en el resumen (no es dato del documento).
  - `CLASIFICACION ASSET CLASS` = `Venture Late Stage` → se muestra como `Private Equity`
    (mismo override para el campo `strategy`, ignorando lo que diga `Estrategia general`).
  - Ticker `KDK` (Kodiak): aunque su `CLASIFICACION ASSET CLASS` en el Excel diga `Renta
    Variable`, se muestra como `Alternativos` — override manual histórico, no viene del Excel.
  - Sector de posiciones privadas (`Venture Late Stage`): default `Technology`, EXCEPTO
    `MVPV23` que conserva su sector restaurado del Excel (`Technology Hardware & Equipment`).
    Julio agregó una privada nueva, `Space X (26B)` → se le aplicó el default `Technology`.
- Validación obligatoria antes de publicar: `total` calculado debe cuadrar contra el escalar
  `AUM` de la hoja `General` del mismo Excel (julio cuadró exacto: $23,153,091.85).

### Sección "Value" (BRK/A, CPB, HOG, STZ — múltiplos P/B, P/E, EV/EBITDA)
- **Fuente: Excel**, hoja `Current Value Stories OK`. Trae su propio "As of" (fecha de corte).
- Julio NO se tocó: el "As of" seguía en 30-jun-2026 (Kevin no envió una versión nueva de esa
  hoja este mes) — el script debe comparar el "As of" contra lo ya publicado y solo tocar esta
  sección si cambió, igual que se hizo hoy (se dejó intacta a propósito, no es un olvido).

### Materiales descargables (botones "Presentación" / "Última carta mensual")
- **Presentación** → SOLO cambia el link, al PDF (español) de `Marketing/Presentaciones GVV/`.
  No afecta ningún número. **⚠ GOTCHA (descubierto 2026-08-07):** el nombre del archivo
  ("Cretum GVV Julio 2026 Español.pdf") indica el mes en que se DISTRIBUYE la presentación,
  NO el mes de los datos que trae adentro — la de "Julio" fue creada el 07-jul con el cierre
  de JUNIO (julio ni había terminado). El script `update_gvv_dashboard.py` por eso NUNCA
  confía en el nombre: abre el PDF y compara su propio "YTD 20XX X%" (página de resumen de
  desempeño) contra el YTD oficial de la carta del mes que se está publicando; si no coincide
  (tolerancia 0.15pp), NO toca el link ya publicado — mejor dejar el anterior que enlazar algo
  desactualizado con un nombre que aparenta estar al día. Caso real: julio quedó sin
  presentación nueva (la única candidata en Dropbox traía YTD 8.41%, la carta de julio decía
  9.07%) — el link se quedó en la presentación de junio (misma que ya estaba).
- **Última carta mensual** → SOLO cambia el link, al PDF de `Marketing/Carta Mensual/<año>/`.
  Se sirve desde `cretumdesk.com/docs/...` (mismo repo, Vercel) — NO desde cretumpartners.com
  (ese dominio depende de FTP manual desde la Mac, evitarlo mientras no haya ese acceso aquí).

## Automatización (activa desde 2026-08-07)
`tools/update_gvv_dashboard.py` en el repo `cretum-reports` (Mac Mini) corre cada hora
(`com.cretum.gvv-dashboard-sync`, `~/srv/ops/gvv_dashboard_sync.sh`, log en
`~/srv/logs/gvv_dashboard_sync.log`). Jala los 3 documentos directo de las carpetas de
Dropbox de Kevin/el equipo (login con `CRETUMDESK_EMAIL`/`PASSWORD`, password grant de
Supabase -> Bearer JWT -> `/api/dropbox`, NO requiere sesión de navegador ni credenciales
propias de Dropbox). Estado en `_state/gvv_dashboard_sync.json` (últimos `modified` vistos
por documento, para no reprocesar lo mismo). Backup del HTML anterior en
`_state/gvv_backup_<timestamp>.html` antes de cada escritura.

Publica solo (commit + push) si el AUM calculado cuadra contra el escalar del Excel
(tolerancia 0.5%) Y el rendimiento mensual del Excel coincide con el de la carta
(tolerancia 0.05 pp) — si cualquiera de las 2 no cuadra, PARA sin publicar y avisa por
Telegram. Si publica, también avisa por Telegram con el resumen (altas/bajas, AUM, rendimiento).
Validado end-to-end contra el cierre real de julio 2026 (mismos números que la corrida manual).

## Resumen de la corrida de hoy (julio 2026, 2026-08-06)
- TRACK jul = 0.61 (carta y Excel coinciden) · TRACKNET jul = 0.35 (Excel).
- cagr5 14.76 / oneYr 36.83 (carta, oficiales) · cum5y 99.05 (derivado).
- cagr5Net 10.62 / cum5yNet 65.62 / oneYrNet 27.57 (derivados, método de razón).
- Holdings: 164 líneas (135 públicas + 8 privadas) vs 147 el mes anterior — 25 altas, 8 bajas,
  +1 privada nueva (Space X 26B, sector default Technology). AUM $23,153,091.85, cuadra exacto.
- Value Stories: sin cambios (Excel sigue con corte a 30-jun-2026).
- Presentación: sin cambios (la de julio en Dropbox es de principios de julio; agosto la
  manda Eugenio manualmente, no está automatizado el "cuál mes corresponde mostrar" todavía).
