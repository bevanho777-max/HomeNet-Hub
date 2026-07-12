-- token_speed.sql — read-only throughput sample (§5.5)  ·  NEUTRAL EXAMPLE
--
-- SECURITY: this file is the ONLY source of SQL. The sql collector NEVER accepts
-- SQL fragments from config or the frontend. The single bound parameter $1 is a
-- whitelisted integer (sample count), passed positionally — never concatenated.
--
-- Returns ONE row { speed } = mean tokens/sec over the most recent $1 completions
-- (completion_tokens / request_duration_ms * 1000 = tokens per second).
--
-- ADAPT table/column names to your accounting schema. LiteLLM ships the table:
--   "LiteLLM_SpendLogs"("startTime" timestamptz, completion_tokens int,
--                       request_duration_ms numeric, ...)

SELECT AVG(completion_tokens::numeric / request_duration_ms * 1000) AS speed
FROM (
  SELECT completion_tokens, request_duration_ms
  FROM "LiteLLM_SpendLogs"
  WHERE completion_tokens > 0 AND request_duration_ms > 0
  ORDER BY "startTime" DESC
  LIMIT $1
) r;
