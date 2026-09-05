-- client_usage.sql — read-only per-KEY chat usage, keyed by digest (§ client manager)
--
-- SECURITY: this file is the ONLY source of SQL; the collector never accepts SQL from
-- config or the frontend. Param-less — i.e. ZERO injection surface — and it passes the
-- same door as every other query: resolved strictly from queries/ , read-only,
-- statement_timeout enforced.
--
-- WHY A SECOND FILE next to project_tokens.sql: that one produces a DISPLAY label
-- (masked hash, "(master key)", "(unattributed)") for a card. This one is a join key —
-- it returns the raw digest so the server can look each row up in LiteLLM's key API and
-- attach the name a human actually typed. Merging them would mean either leaking full
-- digests onto a public board or making the card query carry a column it must not show.
--
-- `api_key` here is LiteLLM's sha256 digest of the key a request came in on, except for
-- the proxy master key, which is the config literal 'litellm_proxy_master_key' and has
-- no row in the key table at all. The caller special-cases that sentinel.
--
-- IT IS ALSO, ON AN INTERNET-FACING GATEWAY, A DUMPING GROUND. Every rejected request is
-- accounted under whatever string the caller sent as its key, so this column holds
-- scanner junk, shell fragments people pasted by mistake, and — observed on this
-- deployment — other services' live credentials that someone pasted into the wrong
-- field. THE CALLER MUST NEVER ECHO A raw_key IT DID NOT RECOGNISE: /api/clients matches
-- each value against the digests LiteLLM's key API returned, plus the master sentinel,
-- and folds everything else into one anonymous count. This query returns the column
-- because that matching needs it, not because it is safe to display.
--
-- Chat口径 identical to project_tokens.sql, from the same list, deliberately duplicated
-- rather than shared: two files that must agree are easier to keep honest than one file
-- with a mode flag, and the list is four lines.
--
-- ADAPT table/column names. LiteLLM ships "LiteLLM_DailyUserSpend"(api_key text,
--   date text, model text, prompt_tokens bigint, completion_tokens bigint,
--   cache_read_input_tokens bigint, api_requests bigint, ...).

WITH excluded_models(pattern) AS (
  VALUES
    ('%embed%'),    -- catch-all: text-embedding-*, mxbai-embed-*, nomic-embed-*, …
    ('%bge%'),      -- BAAI/bge-* embedding family (name carries no "embed")
    ('%gte-%'),     -- Alibaba GTE embedding family (hyphen keeps it off chat names)
    ('%rerank%')    -- cross-encoder rerankers: same machine-traffic story
),
chat AS (
  SELECT
    d.api_key                          AS raw_key,
    d.date::date                       AS day,
    d.prompt_tokens::bigint            AS prompt_tokens,
    d.cache_read_input_tokens::bigint  AS cache_read_tokens,
    d.completion_tokens::bigint        AS completion_tokens,
    d.api_requests::bigint             AS requests
  FROM "LiteLLM_DailyUserSpend" d
  WHERE NOT EXISTS (
    SELECT 1 FROM excluded_models x WHERE lower(d.model) LIKE x.pattern
  )
)
SELECT
  COALESCE(raw_key, '')                                            AS raw_key,
  COALESCE(SUM(prompt_tokens + completion_tokens), 0)::bigint      AS tokens_total,
  -- Actually-new tokens: the prompt minus the prefix that came back from KV cache, plus
  -- the completion. GREATEST is applied to the SUMS, not per row, so the definition is
  -- the key's total rather than a row-wise clamp that could quietly differ.
  (GREATEST(COALESCE(SUM(prompt_tokens), 0) - COALESCE(SUM(cache_read_tokens), 0), 0)
   + COALESCE(SUM(completion_tokens), 0))::bigint                  AS net_total,
  COALESCE(SUM(requests), 0)::bigint                               AS requests_total,
  -- "Today" is the CURRENT_DATE bucket. LiteLLM writes `date` in UTC and only at day
  -- granularity, so this is the UTC day — the same bucket every other card on this
  -- board reports, and not something this query can improve on.
  COALESCE(SUM(prompt_tokens + completion_tokens)
           FILTER (WHERE day = CURRENT_DATE), 0)::bigint           AS tokens_today,
  COALESCE(SUM(requests) FILTER (WHERE day = CURRENT_DATE), 0)::bigint AS requests_today,
  MAX(day)::text                                                   AS last_day
FROM chat
GROUP BY raw_key
ORDER BY tokens_total DESC;
