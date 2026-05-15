# Cretum Dashboard

Dashboard interno para equipo Cretum. Soporta dos empresas (Cretum / MVP) con módulos compartidos:

- **To Do Dashboard** — Tareas personales y de equipo, asignaciones con seguimiento de progreso, vistas Lista / Kanban / Timeline.
- **Base de Datos** — Inversionistas y posiciones del portafolio (LP tracking).
- **Recordatorios semanales** por email configurables por usuario.

## Stack

- **Hosting**: Vercel (serverless functions + static)
- **Base de datos**: Supabase (Postgres + Auth + RLS)
- **Caché de tareas**: Upstash Redis (vía `REDIS_URL`)
- **Emails transaccionales**: Resend
- **Frontend**: HTML / CSS / JS vanilla (sin framework, sin build step)
- **Backend**: Node.js serverless functions (`api/*.js`)

## Estructura

```
.
├── api/
│   ├── config.js      # devuelve SUPABASE_URL + ANON_KEY al frontend
│   ├── tasks.js       # GET/POST de tareas (Redis), valida JWT de Supabase
│   └── reminder.js    # cron diario + endpoint manual (Resend)
├── db/
│   ├── 01_schema.sql       # tablas + RLS + triggers
│   └── 02_reminders.sql    # columnas de preferencias de recordatorio
├── public/
│   ├── index.html     # toda la UI (single page)
│   ├── logo.png, logo-icon.png, logo-mvp.png
├── scripts/
│   └── import_excel.mjs    # importa el Excel de inversionistas a Supabase
├── package.json
└── vercel.json        # builds + routes + cron
```

## Variables de entorno (Vercel → Settings → Environment Variables)

| Variable | Para qué |
|---|---|
| `SUPABASE_URL` | Project URL de Supabase (`https://xxx.supabase.co`) |
| `SUPABASE_ANON_KEY` | Anon public key (segura para frontend) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key — **Sensitive**, solo backend |
| `REDIS_URL` | Connection string de Upstash Redis (TCP+TLS) |
| `RESEND_API_KEY` | API key de Resend para enviar correos |
| `CRON_SECRET` | String aleatorio largo — Vercel lo usa para autorizar el cron diario |

## Setup inicial (clonar y desplegar desde cero)

### 1. Clonar el repo

```bash
git clone https://github.com/ANGEL-0G/Cretum_Dashboard.git
cd Cretum_Dashboard
npm install
```

### 2. Crear proyecto en Supabase

1. https://supabase.com → New project
2. SQL Editor → pega y corre [db/01_schema.sql](db/01_schema.sql)
3. SQL Editor → pega y corre [db/02_reminders.sql](db/02_reminders.sql)
4. Authentication → Users → Add user (con Auto Confirm) → crea usuarios admin
5. Para asignar rol admin:
   ```sql
   UPDATE profiles SET role = 'admin', full_name = 'Nombre', initials = 'AB'
   WHERE id = (SELECT id FROM auth.users WHERE email = 'persona@ejemplo.com');
   ```

### 3. Importar datos de inversionistas

```powershell
$env:DATABASE_URL = "postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres"
$env:XLSX_PATH    = "C:\ruta\al\Cretum_MVP LP Tracking Sheet.xlsx"
npm run import
```

(Usa la conexión "Session pooler" de Supabase si tu red no soporta IPv6 — puerto 5432).

### 4. Crear cuenta en Upstash Redis

1. Vercel → Storage → Marketplace → Upstash Redis
2. Crea base de datos en región cercana
3. Conecta al proyecto Vercel — pone `REDIS_URL` automáticamente

### 5. Crear cuenta en Resend

1. https://resend.com → registra cuenta
2. API Keys → crea una con `Sending access`
3. Para enviar a correos reales del equipo, verifica tu dominio en Resend → Domains

### 6. Configurar env vars en Vercel

Settings → Environment Variables → agrega las 6 variables de la tabla de arriba.

`CRON_SECRET` debe ser un string largo aleatorio (puedes generar uno con cualquier generador online).

### 7. Deploy

```bash
vercel link   # vincular al proyecto
vercel --prod # primer deploy
```

O conecta el repo de GitHub a Vercel (Settings → Git) para deploy automático en cada `git push` a `main`.

## Dominio personalizado

1. Vercel → Settings → Domains → Add → escribe el dominio
2. Vercel da uno o dos registros DNS (CNAME para subdominio, A record para raíz)
3. Agrega esos registros con tu proveedor de dominio
4. Espera propagación + SSL automático
5. Listo

## Roles

| Rol | Permisos |
|---|---|
| `viewer` | Solo lectura — ve tareas y base de datos |
| `editor` | Crea/edita tareas, edita portafolio |
| `admin` | Todo + cambiar roles |

## Recordatorios

- Cron diario corre 8 AM CDMX (14:00 UTC) — `vercel.json`
- Cada usuario configura su día y hora preferida en el menú de perfil
- El cron filtra usuarios por día y manda email con su resumen personalizado
- Sin dominio verificado en Resend, todos los emails se redirigen al email registrado en Resend (constante `ON_DEMAND_RECIPIENT` en [api/reminder.js](api/reminder.js)). Una vez verificado el dominio, cambiar a `user.email`.

## Desarrollo local

```bash
vercel dev
```

Levanta en `http://localhost:3000` con las env vars del proyecto Vercel.

## Migrar datos del Excel cuando cambien

Re-ejecuta `npm run import` con `DATABASE_URL` apuntando a Supabase. El script hace `TRUNCATE contacts, investments` y vuelve a insertarlo todo (con `ON CONFLICT` en `investors`, `companies`, `series` para no duplicar).
