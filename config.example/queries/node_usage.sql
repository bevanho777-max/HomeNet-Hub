-- Today's (Beijing day) requests and tokens that went THROUGH LiteLLM, per backend, for the
-- 推理节点 / Inference Nodes card (type: inference_nodes). The node's TOTAL usage comes from
-- the inference servers' own counters in Prometheus; this is only the "of which via
-- LiteLLM" line.
--
-- LiteLLM_SpendLogs, not the daily table: it has one row per request with the backend's
-- api_base (so a row maps to exactly one machine) and a real timestamp (so "today" can be
-- the Beijing day; the daily table is bucketed by UTC date). startTime is stored as UTC
-- without a zone. SpendLogs keeps 7 days (~/bin/litellm-spendlogs-prune), plenty for today.
-- Rows without an api_base never reached a backend (auth failures, unknown model) and are
-- returned too, so the collector can report them as unassigned instead of dropping them.
--
-- v2.29: one row per backend x call type x minute x "produced tokens" (ok), so the hub can
--   * count only the requests that reached a model: a call that failed before any token did
--     no work on the node, and the node's own counters never see it;
--   * fill a counter's gap -- the minutes in which a node's counters were not collected
--     (a restart before the first scrape, a broken scrape) -- from these rows.
SELECT
  COALESCE(api_base, '') AS api_base,
  COALESCE(call_type, '') AS call_type,
  (extract(epoch FROM date_trunc('minute', "startTime")))::bigint AS minute,
  ((COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)) > 0)::int AS ok,
  COUNT(*)::bigint AS requests,
  (COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0))::bigint AS tokens
FROM "LiteLLM_SpendLogs"
WHERE "startTime" >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC'
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;
