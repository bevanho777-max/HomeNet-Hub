-- v2.24 usage: LiteLLM requests in [$1, $2) (unix seconds), one row per minute x api_key x
-- model x backend. Read by server/usage.js for the Token Usage card, its detail modal, the
-- Per-Project table and the Clients panel.
--
-- LiteLLM_SpendLogs, not the daily tables: one row per request with a real timestamp (so a
-- "day" can be the Beijing day -- the daily tables are bucketed by UTC date) and the
-- backend's api_base (so a request that went through LiteLLM to a node can be recognised
-- and not counted twice once that node's own counters are in use). startTime is stored as
-- UTC without a zone and is indexed (LiteLLM_SpendLogs_startTime_idx), so the window below
-- is an index range scan. Grouping per minute bounds the result: even a retry storm of
-- 300k requests a day comes back as at most 1440 rows per key/model/backend.
--
-- requests = successful rows only (a failed call did no work on any backend; the old daily
-- table counted only part of them anyway). tokens = prompt + completion as LiteLLM bills
-- them; cached = the prompt prefix served from the backend's KV cache, so the hub can
-- derive the actually-computed tokens (prompt - cached + completion).
-- v2.29: ok_requests = the successful rows that produced tokens, i.e. reached a model: what a
-- node's own request counter can see (used to fill the minutes a counter was not collected).
SELECT
  (extract(epoch FROM date_trunc('minute', "startTime")))::bigint                AS minute,
  COALESCE(api_key, '')                                                          AS api_key,
  COALESCE(model, '')                                                            AS model,
  COALESCE(api_base, '')                                                         AS api_base,
  COUNT(*) FILTER (WHERE status = 'success')::bigint                             AS requests,
  COUNT(*) FILTER (WHERE status = 'success'
    AND COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0) > 0)::bigint AS ok_requests,
  COALESCE(SUM(prompt_tokens), 0)::bigint                                        AS prompt,
  COALESCE(SUM(completion_tokens), 0)::bigint                                    AS completion,
  COALESCE(SUM((metadata->'usage_object'->'prompt_tokens_details'->>'cached_tokens')::bigint), 0)::bigint AS cached
FROM "LiteLLM_SpendLogs"
WHERE "startTime" >= to_timestamp($1) AT TIME ZONE 'UTC'
  AND "startTime" <  to_timestamp($2) AT TIME ZONE 'UTC'
GROUP BY 1, 2, 3, 4;
