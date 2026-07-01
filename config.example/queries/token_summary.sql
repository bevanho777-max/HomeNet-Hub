-- token_summary.sql — read-only token accounting (§5.5)  ·  NEUTRAL EXAMPLE
--
-- SECURITY: this file is the ONLY source of SQL. The sql collector NEVER accepts
-- SQL fragments from config or the frontend. The single bound parameter $1 is a
-- whitelisted integer (range in days), passed positionally.
--
-- Returns one row per (model, day) for the last $1 days. Raw model names are
-- returned AS-IS; bucketing into display categories is done entirely by the
-- token target's `classify` block in targets.yaml — so the dashboard can
-- re-categorize without ever touching this SQL.
--
-- ADAPT the table/column names below to your real accounting schema. This
-- example assumes a table:
--   token_usage(ts timestamptz, model text, tokens bigint, requests bigint)

SELECT
  model,                                   -- raw model identifier (classified by config)
  (ts AT TIME ZONE 'UTC')::date AS day,    -- bucket day (adjust TZ to taste)
  SUM(tokens)::bigint           AS tokens, -- total tokens that day for that model
  SUM(requests)::bigint         AS requests-- request count that day for that model
FROM token_usage
WHERE ts >= (now() - ($1::int || ' days')::interval)
GROUP BY model, day
ORDER BY day ASC, model ASC;
