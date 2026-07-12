-- token_total.sql — read-only CUMULATIVE (all-time) token accounting (§5.5) · NEUTRAL EXAMPLE
--
-- SECURITY: this file is the ONLY source of SQL; the collector never accepts SQL
-- from config or the frontend. This aggregate takes NO bound parameter (all-time)
-- — i.e. ZERO injection surface. It passes the same door as every other query:
-- resolved strictly from queries/ , read-only, statement_timeout enforced.
--
-- COST: this scans the full table, so the app runs it on a SLOW cycle and caches
-- the result (~10 min). The live day-trend stays on the windowed
-- token_summary.sql ($1 days), which is cheap with an index on "startTime".
--
-- Returns one row per model: cumulative tokens + request count over ALL time
-- (v1 全量口径 → SUM(total_tokens); requests = COUNT(*)). Raw model names are
-- returned AS-IS; classification is done by the target's `classify` block.
--
-- ADAPT table/column names. LiteLLM ships "LiteLLM_SpendLogs"(model text,
--   total_tokens int, "startTime" timestamptz, ...).

SELECT
  model,
  SUM(total_tokens)::bigint AS tokens,
  COUNT(*)::bigint          AS requests
FROM "LiteLLM_SpendLogs"
GROUP BY model;
