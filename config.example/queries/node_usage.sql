-- Today's usage per model, for the 推理节点 / Inference Nodes card (type: inference_nodes).
--
-- Deliberately the SAME rows the Token Usage card counts as "Today" (token_summary.sql):
-- LiteLLM_DailyUserSpend, the latest date bucket (LiteLLM writes UTC dates), every key,
-- tokens = prompt + completion. The collector then splits these rows by node with each
-- node's model regex, so the node columns plus `unassigned` add up to that card's total.
-- (The gateway card m24 uses a different day — the Beijing date — and excludes health
-- checks; the two are not meant to agree.)
SELECT
  model,
  COALESCE(SUM(api_requests), 0)::bigint AS requests,
  COALESCE(SUM(prompt_tokens + completion_tokens), 0)::bigint AS tokens,
  MAX(date) AS day
FROM "LiteLLM_DailyUserSpend"
WHERE date = (SELECT MAX(date) FROM "LiteLLM_DailyUserSpend")
GROUP BY model
ORDER BY model;
