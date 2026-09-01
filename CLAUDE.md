# CLAUDE.md — Cretum Dashboard (reglas compartidas del equipo)

Dashboard interno de Cretum/MVP. Producción: **https://cretumdesk.com**. Idioma de trabajo: **español** (UI, commits, comentarios). Frontend vanilla (HTML/CSS/JS, sin framework ni build) en `public/index.html` + `public/app.js`; APIs serverless en `api/` (Vercel) + Supabase.

## ⚠️ REGLA #1 — Modo oscuro desde el primer commit

Toda UI nueva debe verse bien en **los TRES temas** antes de darse por terminada:

1. **Claro** (default)
2. **Oscuro**: `[data-theme="dark"]`
3. **Oscuro MVP** (cálido/naranja): `[data-theme="dark"][data-org="mvp"]`

Cómo lograrlo:

- **Usa SOLO los tokens del tema**: `--white`, `--gray-50…900`, `--navy`, `--navy-pale/ghost/light`, `--green/--green-bg`, `--red/--red-bg`, `--amber/--amber-bg`, `--blue/--blue-bg`, `--card`. Todos cambian solos con el tema (p. ej. `--white` es `#fff` en claro y `#161b24` en oscuro).
- **NUNCA** hardcodees colores de modo claro (`#fff`, `#f8f9fc`, cremas, pasteles) en fondos o textos de componentes temáticos, ni inventes tokens que no existen (`--ink`, `--line`, `--card-bg`… si no está en `:root`, no existe: cae al fallback claro y **se rompe en oscuro**).
- **Texto sobre el acento en dark**: `--navy` se aclara en oscuro (azul `#5d8ff5` / naranja `#F89540`), así que texto blanco encima pierde contraste. Patrones aceptados: texto `var(--white)` (se vuelve oscuro en dark, como `.btn-primary`), o fijar el acento fuerte en dark (`#ED7824` en MVP) para conservar texto blanco.
- Un bloque **autocontenido** (fondo Y texto explícitos, p. ej. banda navy `#0f2849` con texto `#fff`) es válido: se lee igual en ambos temas.
- Superficies oscuras de referencia: tarjetas `#1a1a1a`/`var(--gray-50)`; en MVP oscuro las superficies son cálidas (`#1a1610`, `#12100a` — ver overrides `[data-theme="dark"][data-org="mvp"]` existentes).
- **Checklist antes de terminar**: alterna el switch de Modo oscuro del menú del perfil en Cretum Y en MVP y revisa tu componente. Texto invisible o bordes que rechinan = no está terminado.

## Reglas de la casa (frontend)

- **Botón "atrás" del teléfono**: TODO modal/overlay/drawer/sub-pantalla nuevo se registra en `dismissTopLayer()` (app.js) para que "atrás" lo cierre en vez de salir de la app. Los que usan `.modal-backdrop` o `.cdd` ya están cubiertos por los selectores genéricos.
- **i18n**: strings de UI en español como clave, envueltos en `t('…')` (o `data-i18n` en markup estático), y su traducción EN agregada al diccionario de `public/i18n.js`.
- **vercel.json es allowlist**: todo archivo estático nuevo que deba servirse necesita su entrada en `builds`/`routes`, si no devuelve el index. Plan Vercel Pro (el tope de 12 funciones del Hobby ya no aplica) — aun así, prefiere hablar con Supabase directo (RLS) antes de crear `api/*.js` nuevos.
- **Sistema visual**: DM Sans (400/500, máx 600), UI densa 11–13px, radios 5/8/12px, acento puntual (navy Cretum / naranja MVP), sin gradientes ni sombras pesadas. Animaciones solo `transform`/`opacity` (o `grid-template-rows` para plegar), 150–300ms, curva `cubic-bezier(.23,1,.32,1)`, `:active{scale(.97)}` en botones, y respeta `prefers-reduced-motion`.
- **Verifica sintaxis** antes de commitear: `node --check public/app.js public/i18n.js`.
- **Nunca borres el trabajo sin commitear de otras sesiones** (suele haber más de un Claude trabajando en este repo): commitea solo tus archivos, y usa `git stash -u` + `pull --rebase` + `stash pop` si el push choca.
