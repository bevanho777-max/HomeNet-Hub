-- v2.46 LiteLLM requests for the inference nodes, ONE ROW PER REQUEST, in [$1, $2) (unix seconds,
-- by start time). Read by server/collectors/nodes.js (nodeFigures): the single computation behind
-- the 推理节点 card, its detail charts and summary line, and the Token Usage card's per-node figures.
--
-- Per request, not per minute, because a node's figure needs each request's START (which minute
-- it belongs to: a minute the node's own counter did not cover is filled from these rows) and its
-- END (a request that finished after the counter's last scrape but before the server restarted
-- was counted by the server and lost with the restart: these rows put it back). A day is a few
-- hundred to a few thousand rows.
--
-- ok = the request reached a model and produced tokens (what the node's own counters can see).
-- tokens = prompt + completion as LiteLLM bills them (the server's own usage report); cached = the
-- prompt prefix served from the backend's KV cache (net = prompt - cached + completion).
-- startTime / endTime are stored as UTC without a zone. Rows without an api_base never reached a
-- backend: returned too, so the collector can report them as unassigned.
SELECT
  extract(epoch FROM "startTime")::float8                                         AS st,
  extract(epoch FROM COALESCE("endTime", "startTime"))::float8                   AS en,
  COALESCE(api_base, '')                                                         AS api_base,
  COALESCE(call_type, '')                                                        AS call_type,
  ((COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)) > 0)::int       AS ok,
  COALESCE(prompt_tokens, 0)::bigint                                             AS prompt,
  COALESCE(completion_tokens, 0)::bigint                                         AS completion,
  COALESCE((metadata->'usage_object'->'prompt_tokens_details'->>'cached_tokens')::bigint, 0)::bigint AS cached
FROM "LiteLLM_SpendLogs"
WHERE "startTime" >= to_timestamp($1) AT TIME ZONE 'UTC'
  AND "startTime" <  to_timestamp($2) AT TIME ZONE 'UTC'
ORDER BY "startTime";
