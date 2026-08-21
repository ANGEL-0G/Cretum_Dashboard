-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Email en los rankings SOLO para quien accede a la BD Cretum
-- Los rankings (apertura/campañas) siguen ocultando el correo a viewers y
-- colaboradores. Se agrega una columna `email` que solo se llena si el que
-- consulta puede ver la Base de Datos Cretum (can_cretum_db() — excluye al rol
-- colaborador), para poder abrir la ficha del contacto sin filtrar correos.
-- Recrear (DROP+CREATE) porque cambia el tipo de retorno.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists public.apertura_ranking();
create function public.apertura_ranking()
returns table(nombre text, score integer, dias_vistos integer, ultimo_dia date, momentum text, historial jsonb, email text)
language sql stable security definer set search_path to 'public'
as $function$
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
         historial,
         CASE WHEN public.can_cretum_db() THEN agg.email ELSE NULL END
  FROM agg WHERE dias_vistos>=1
  ORDER BY score DESC, dias_vistos DESC, nombre;
$function$;
grant execute on function public.apertura_ranking() to authenticated;

drop function if exists public.campaign_ranking();
create function public.campaign_ranking()
returns table(nombre text, score integer, meses_vistos integer, ultimo_periodo date, momentum text, historial jsonb, email text)
language sql stable security definer set search_path to 'public'
as $function$
  WITH per AS (SELECT DISTINCT periodo FROM campaign_engagement),
       ranked AS (SELECT periodo, row_number() OVER (ORDER BY periodo DESC) rn FROM per),
       lastp AS (SELECT periodo FROM ranked WHERE rn = 1),
       prevp AS (SELECT periodo FROM ranked WHERE rn = 2),
       agg AS (
         SELECT c.email,
                COALESCE(c.nombre_completo, c.nombre, 'LP') AS nombre,
                COALESCE(SUM(e.nivel), 0) AS score,
                COUNT(*) FILTER (WHERE e.nivel >= 1) AS meses_vistos,
                MAX(e.periodo) FILTER (WHERE e.nivel >= 1) AS ultimo_periodo,
                COALESCE(MAX(e.nivel) FILTER (WHERE e.periodo = (SELECT periodo FROM lastp)), 0) AS last_n,
                COALESCE(MAX(e.nivel) FILTER (WHERE e.periodo = (SELECT periodo FROM prevp)), 0) AS prev_n,
                COALESCE(jsonb_agg(jsonb_build_object(
                    'periodo', e.periodo, 'opened', e.opened, 'clicked', e.clicked,
                    'replied', e.replied, 'nivel', e.nivel) ORDER BY e.periodo)
                  FILTER (WHERE e.periodo IS NOT NULL), '[]'::jsonb) AS historial
         FROM lp_contacts c
         LEFT JOIN campaign_engagement e ON e.email = c.email
         WHERE COALESCE(c.cancelado, FALSE) = FALSE
         GROUP BY c.email, COALESCE(c.nombre_completo, c.nombre, 'LP')
       )
  SELECT nombre, score::INT, meses_vistos::INT, ultimo_periodo,
         CASE WHEN last_n >= 1 AND last_n >= prev_n THEN 'up'
              WHEN last_n < prev_n THEN 'down'
              ELSE 'flat' END AS momentum,
         historial,
         CASE WHEN public.can_cretum_db() THEN agg.email ELSE NULL END
  FROM agg WHERE meses_vistos >= 1
  ORDER BY score DESC, meses_vistos DESC, nombre;
$function$;
grant execute on function public.campaign_ranking() to authenticated;
