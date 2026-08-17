# Tablero del equipo (Slack → home MVP)

El home de MVP muestra un **Tablero del equipo** con avisos, noticias y eventos.
Lo alimentan dos fuentes:

1. **Rutina de Claude en la nube** — corre a las **8:00 y 18:00 CDMX** con los
   conectores de claude.ai de Angel (Slack + Supabase). Lee `#general` del
   workspace mvpvc, clasifica los mensajes y los inserta en la tabla
   `bulletin_items`. **No usa Slack App, ni bot token, ni GitHub Secrets** —
   es la misma conexión OAuth con la que Claude lee Slack en las sesiones.
2. **Notas manuales** — cualquier usuario del dashboard puede publicar con el
   botón **+ Nota** del tablero.

## La rutina

- Nombre: **"Tablero MVP — digest de Slack (8:00 y 18:00 CDMX)"**
- ID: `trig_01HjKAVXUtTVu6pynBBqxKhR`
- Cron: `0 0,14 * * *` UTC (= 18:00 y 8:00 CDMX)
- Administrarla (pausar, editar, ver corridas, borrar):
  https://claude.ai/code/routines/trig_01HjKAVXUtTVu6pynBBqxKhR
- Conectores: Slack y Supabase de la cuenta de Angel (claude.ai/customize/connectors).
  ⚠️ Si se desconecta alguno de los dos conectores, la rutina deja de funcionar.

## Cómo clasifica

- **aviso** — anuncios operativos (@channel, distribuciones, compliance, equipo)
- **noticia** — links y novedades de mercado
- **evento** — cosas con fecha (visitas a oficina, reuniones); la fecha va a
  `event_date` y aparece en la columna "Próximos eventos"
- Descarta ruido: felicitaciones, "gracias", respuestas de hilo, joins.
- Idempotente: cada mensaje entra una sola vez (índice único `org + slack_ts`);
  la rutina solo hace INSERT, nunca UPDATE/DELETE.

## Tablas (Supabase, proyecto cretum-dashboard)

- `bulletin_items` — items del tablero. RLS: lectura para autenticados,
  insert manual solo con `created_by = auth.uid()`, delete para el autor o admin.
- `bulletin_runs` — bitácora de corridas (alimenta el "Actualizado hoy 8:00"
  del panel). La rutina inserta una fila por corrida aunque no haya items nuevos.

## Frontend

- Panel: `updateHomeBoard()` / `renderBoard()` en `public/app.js`; estilos `.hb-*`
  en `public/index.html`; composer `#hbComposer` (se cierra con el back del
  teléfono vía `dismissTopLayer`). Solo visible en el home de MVP.
