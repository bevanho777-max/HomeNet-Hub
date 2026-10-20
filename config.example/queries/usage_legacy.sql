-- v2.24 usage: the days before the per-request log is used (`logs_since`, $1 = unix
-- seconds). SpendLogs keeps only ~7 days, so older history exists only in LiteLLM's daily
-- table -- bucketed by UTC date, with no backend column. These days keep their UTC-date
-- label (the detail modal says so) and are LiteLLM-only by nature: no inference-server
-- counter is used before logs_since, so nothing here can be counted twice.
-- requests = successful_requests, matching usage_rows.sql (successful rows only).
SELECT
  date::text                                         AS day,
  COALESCE(api_key, '')                              AS api_key,
  COALESCE(model, '')                                AS model,
  COALESCE(SUM(prompt_tokens), 0)::bigint            AS prompt,
  COALESCE(SUM(completion_tokens), 0)::bigint        AS completion,
  COALESCE(SUM(cache_read_input_tokens), 0)::bigint  AS cached,
  COALESCE(SUM(successful_requests), 0)::bigint      AS requests
FROM "LiteLLM_DailyUserSpend"
WHERE date::date < (to_timestamp($1) AT TIME ZONE 'UTC')::date
GROUP BY 1, 2, 3;
