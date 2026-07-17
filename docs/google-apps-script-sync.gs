/**
 * Cretum Desk ⇄ Google Sheets — puente durante la migración de campañas
 * ─────────────────────────────────────────────────────────────────────
 * QUÉ HACE
 *   Recibe la matriz de campañas desde Cretum Desk (botón "Sincronizar
 *   Sheets" en Gestión) y reescribe la pestaña del Sheets con el mismo
 *   formato del Exportar Excel. ANTES de reescribir, lee los Comentarios
 *   y Responsable que el equipo haya escrito en el Sheets y esos GANAN
 *   (se devuelven a Cretum Desk para que también se actualicen allá).
 *   La marca CANCELÓ de Cretum Desk se preserva siempre.
 *
 * CÓMO INSTALARLO (una sola vez, ~3 min)
 *   1. Abre el Google Sheets "Bloques de Envios LP's GVV"
 *   2. Extensiones → Apps Script → borra lo que haya → pega este archivo
 *   3. Ajusta TAB (nombre exacto de la pestaña) y SECRET (te lo paso aparte)
 *   4. Implementar → Nueva implementación → tipo "Aplicación web":
 *        - Ejecutar como: Yo
 *        - Quién tiene acceso: Cualquier persona
 *   5. Copia la URL que termina en /exec y mándamela para guardarla
 *      como SHEETS_WEBAPP_URL en Vercel.
 *
 * SEGURIDAD: la URL es pública pero solo responde si el payload trae el
 * SECRET correcto, que vive en Vercel (server) y aquí — nunca en el front.
 */

var TAB = "LP's";                 // ← nombre exacto de la pestaña a actualizar
var SECRET = 'PEGA_AQUI_EL_SECRETO';

function doPost(e) {
  var out = { ok: false };
  try {
    var p = JSON.parse(e.postData.contents);
    if (!p || p.secret !== SECRET) throw new Error('Secreto inválido');
    if (!p.header || !p.rows || !p.rows.length) throw new Error('Payload vacío');

    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName(TAB);
    if (!sh) sh = ss.insertSheet(TAB);

    // 1) Lee el seguimiento actual del sheet (lo que escribe el equipo)
    var existing = readExisting_(sh);
    var cancelados = {};
    (p.cancelados || []).forEach(function (em) { cancelados[String(em).toLowerCase()] = true; });
    var destacados = {};
    (p.destacados || []).forEach(function (em) { destacados[String(em).toLowerCase()] = true; });

    // 2) Merge: si el sheet tiene Comentarios/Responsable, el sheet gana
    //    (es donde el equipo da seguimiento hoy). CANCELÓ se preserva.
    var rows = p.rows.map(function (r) {
      var email = String(r[0] || '').toLowerCase().trim();
      var ex = existing[email] || {};
      var resp = (ex.responsable || '').trim() || String(r[3] || '');
      var com = (ex.comentarios || '').trim() || String(r[4] || '');
      if (cancelados[email] && com.indexOf('CANCELÓ') === -1) {
        com = com ? com + ' · CANCELÓ' : 'CANCELÓ';
      }
      return [r[0], r[1], r[2], resp, com].concat(r.slice(5));
    });

    // 3) Reescribe la hoja completa
    var nCols = p.header.length;
    // Deshace TODAS las combinaciones de la hoja (no solo el rango de datos):
    // si una sync previa tenía más meses, esas combinaciones de encabezado se
    // extienden más allá de los datos actuales y breakApart() sobre getDataRange()
    // falla con "You must select all cells in a merged range to merge or unmerge them".
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
    sh.clear();
    var all = [p.header].concat(rows);
    sh.getRange(1, 1, all.length, nCols).setValues(all);

    // Formato: encabezado en negritas y centrado, meses combinados (3 cols c/u)
    sh.getRange(1, 1, 1, nCols)
      .setFontWeight('bold').setHorizontalAlignment('center')
      .setBackground('#17436b').setFontColor('#ffffff');
    var meses = p.meses || Math.floor((nCols - 6) / 3);
    for (var i = 0; i < meses; i++) {
      sh.getRange(1, 7 + i * 3, 1, 3).merge();
    }
    if (rows.length && nCols > 6) {
      sh.getRange(2, 6, rows.length, nCols - 5).setHorizontalAlignment('center');
    }
    // Colores por fila (una sola pasada): cancelados en letra roja,
    // destacados (los que llevan más meses viendo) en fondo naranja claro
    if (rows.length) {
      var bgs = [], fonts = [];
      for (var rI = 0; rI < rows.length; rI++) {
        var em2 = String(rows[rI][0] || '').toLowerCase().trim();
        var bg = destacados[em2] && !cancelados[em2] ? '#fff3e0' : '#ffffff';
        var fc = cancelados[em2] ? '#c0392b' : '#000000';
        var bgRow = [], fcRow = [];
        for (var cI = 0; cI < nCols; cI++) { bgRow.push(bg); fcRow.push(fc); }
        bgs.push(bgRow); fonts.push(fcRow);
      }
      sh.getRange(2, 1, rows.length, nCols).setBackgrounds(bgs).setFontColors(fonts);
    }
    sh.setFrozenRows(1);
    sh.setFrozenColumns(1);

    // Anchos de columna fijos — clear() no resetea anchos, así que "Comentarios"
    // se quedaba estirada de un auto-ajuste viejo. Los fijamos y envolvemos el texto.
    sh.setColumnWidth(1, 220);   // Email
    sh.setColumnWidth(2, 110);   // Nombre
    sh.setColumnWidth(3, 200);   // Nombre Completo
    sh.setColumnWidth(4, 160);   // Responsable
    sh.setColumnWidth(5, 260);   // Comentarios (ancho fijo, ya no se extiende)
    sh.setColumnWidth(6, 55);    // Meses Vistos
    if (meses > 0) sh.setColumnWidths(7, meses * 3, 32);  // sub-columnas ⚡ angostas
    sh.getRange(1, 5, all.length, 1).setWrap(true);       // Comentarios: envuelve en vez de desbordarse

    // 4) Devuelve a Cretum Desk el seguimiento final (para traerlo de vuelta)
    var back = {};
    rows.forEach(function (r) {
      var em3 = String(r[0] || '').toLowerCase().trim();
      if (em3) back[em3] = { responsable: String(r[3] || ''), comentarios: String(r[4] || '') };
    });
    out = { ok: true, filas: rows.length, seguimiento: back };
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/** email(minúsculas) → { comentarios, responsable } leídos de la hoja actual */
function readExisting_(sh) {
  var map = {};
  if (sh.getLastRow() < 1) return map;
  var vals = sh.getDataRange().getValues();
  if (!vals.length) return map;
  var head = vals[0].map(function (v) { return String(v).toLowerCase(); });
  var iEmail = -1, iCom = -1, iResp = -1;
  head.forEach(function (h, i) {
    if (iEmail === -1 && h.indexOf('email') !== -1) iEmail = i;
    if (iCom === -1 && h.indexOf('comentario') !== -1) iCom = i;
    if (iResp === -1 && h.indexOf('responsable') !== -1) iResp = i;
  });
  if (iEmail === -1) return map;
  for (var r = 1; r < vals.length; r++) {
    var em = String(vals[r][iEmail] || '').toLowerCase().trim();
    if (!em) continue;
    map[em] = {
      comentarios: iCom !== -1 ? String(vals[r][iCom] || '') : '',
      responsable: iResp !== -1 ? String(vals[r][iResp] || '') : '',
    };
  }
  return map;
}
