# CRETUM · Pendientes del equipo

App de gestión de tareas con vistas Kanban, Lista y Timeline.  
Deploy en Vercel en ~10 minutos, sin saber de servidores.

---

## Estructura del proyecto

```
cretum-tasks/
├── public/
│   └── index.html      ← toda la app (HTML + CSS + JS)
├── api/
│   └── tasks.js        ← API serverless (guarda/lee tareas)
├── vercel.json         ← configuración de Vercel
├── package.json
└── README.md
```

---

## Paso 1 — Crear cuenta en Vercel (gratis)

1. Ve a **https://vercel.com** y crea una cuenta (puedes usar tu cuenta de GitHub o Google)
2. No necesitas tarjeta de crédito

---

## Paso 2 — Instalar Vercel CLI

Abre una terminal y ejecuta:

```bash
npm install -g vercel
```

Si no tienes Node.js instalado: https://nodejs.org (descarga la versión LTS)

---

## Paso 3 — Hacer el deploy

En la terminal, entra a la carpeta del proyecto y ejecuta:

```bash
cd cretum-tasks
npm install
vercel
```

Vercel te preguntará:
- **Set up and deploy?** → Y
- **Which scope?** → selecciona tu cuenta
- **Link to existing project?** → N
- **Project name?** → `cretum-tasks` (o el que quieras)
- **Directory?** → `.` (punto, la carpeta actual)

Al final te dará una URL tipo `https://cretum-tasks-xxxx.vercel.app`

Para subir a producción:

```bash
vercel --prod
```

---

## Paso 4 — Configurar Vercel KV (para persistencia real)

Sin esto, las tareas se borran si Vercel reinicia el servidor.  
Con KV quedan guardadas permanentemente. Es gratis hasta 256 MB.

1. Ve a **https://vercel.com/dashboard**
2. Entra a tu proyecto → **Storage** → **Create Database** → **KV**
3. Dale un nombre (ej: `cretum-kv`) y click en **Create**
4. En la sección **Environment Variables** click en **Connect to Project**
5. Eso agrega automáticamente las variables `KV_URL`, `KV_REST_API_URL`, etc.
6. Vuelve a hacer deploy: `vercel --prod`

Listo. Las tareas ahora persisten entre sesiones.

---

## Paso 5 — Agregar usuarios

Abre `public/index.html` y busca esta sección cerca del final:

```javascript
const USERS = {
  'admin':  { pass: 'cretum2024', name: 'Admin',    initials: 'AD' },
  'jlopez': { pass: 'cretum2024', name: 'J. López', initials: 'JL' },
  'mvega':  { pass: 'cretum2024', name: 'M. Vega',  initials: 'MV' },
};
```

Agrega o modifica los usuarios con este formato:

```javascript
'nombre_usuario': { pass: 'contraseña', name: 'Nombre que se muestra', initials: 'NI' },
```

Después vuelve a hacer deploy: `vercel --prod`

---

## Paso 6 — Compartir con tu socio

Mándale la URL de producción y sus credenciales.  
La app se refresca automáticamente cada 30 segundos para ver los cambios del otro.

---

## Recordatorio semanal (WhatsApp + Email)

El recordatorio automático de cada lunes se puede implementar con un **Vercel Cron Job**:

1. Crea el archivo `api/reminder.js` con la lógica de envío
2. Agrega en `vercel.json`:
```json
"crons": [
  { "path": "/api/reminder", "schedule": "0 9 * * 1" }
]
```
Esto ejecuta el endpoint cada lunes a las 9 AM (UTC).  
Para ajustar la zona horaria cambia el horario: si estás en CDMX (UTC-6), usa `0 15 * * 1`.

Para el envío en sí:
- **WhatsApp**: usa Twilio o Meta Cloud API con el token que ya tienes del dashboard principal
- **Email**: usa Resend (gratis hasta 3,000 emails/mes) o SendGrid

---

## Desarrollo local

Para probar en tu computadora antes de hacer deploy:

```bash
vercel dev
```

Esto levanta la app en `http://localhost:3000` con hot reload.

---

## Actualizar la app

Cada vez que edites `index.html` o `api/tasks.js`, vuelve a hacer:

```bash
vercel --prod
```

El deploy tarda menos de 30 segundos.
