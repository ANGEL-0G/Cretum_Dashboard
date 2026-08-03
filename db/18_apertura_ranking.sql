-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Ranking de Apertura Cretum Diaria (visible a todos)
--
-- Como campaign_ranking() pero para el correo diario (apertura_engagement por
-- fecha). SECURITY DEFINER: cualquier autenticado puede consultarlo sin abrir
-- la tabla a nivel RLS. Ordena por score (suma de niveles) y días vistos.
--
-- ⚠️ nombre = COALESCE(nombre, email): si el contacto no tiene nombre, muestra
--    el correo (los contactos de Apertura son de mercados, no LPs). Si se
--    prefiere ocultar correos, cambiar a un texto genérico.
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.apertura_ranking()
 RETURNS TABLE(nombre text, score integer, dias_vistos integer, ultimo_dia date, momentum text, historial jsonb)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH per AS (SELECT DISTINCT fecha FROM apertura_engagement),
       ranked AS (SELECT fecha, row_number() OVER (ORDER BY fecha DESC) rn FROM per),
       lastp AS (SELECT fecha FROM ranked WHERE rn=1),
       prevp AS (SELECT fecha FROM ranked WHERE rn=2),
       agg AS (
         SELECT c.email,
                COALESCE(NULLIF(btrim(c.nombre),''), c.email) AS nombre,
                COALESCE(SUM(e.nivel),0) AS score,
                COUNT(*) FILTER (WHERE e.nivel>=1) AS dias_vistos,
                MAX(e.fecha) FILTER (WHERE e.nivel>=1) AS ultimo_dia,
                COALESCE(MAX(e.nivel) FILTER (WHERE e.fecha=(SELECT fecha FROM lastp)),0) AS last_n,
                COALESCE(MAX(e.nivel) FILTER (WHERE e.fecha=(SELECT fecha FROM prevp)),0) AS prev_n,
                COALESCE(jsonb_agg(jsonb_build_object('fecha',e.fecha,'opened',e.opened,'clicked',e.clicked,'nivel',e.nivel) ORDER BY e.fecha) FILTER (WHERE e.fecha IS NOT NULL),'[]'::jsonb) AS historial
         FROM apertura_contacts c
         LEFT JOIN apertura_engagement e ON e.email=c.email
         GROUP BY c.email, COALESCE(NULLIF(btrim(c.nombre),''), c.email)
       )
  SELECT nombre, score::int, dias_vistos::int, ultimo_dia,
         CASE WHEN last_n>=1 AND last_n>=prev_n THEN 'up' WHEN last_n<prev_n THEN 'down' ELSE 'flat' END,
         historial
  FROM agg WHERE dias_vistos>=1
  ORDER BY score DESC, dias_vistos DESC, nombre;
$$;
GRANT EXECUTE ON FUNCTION public.apertura_ranking() TO authenticated;
