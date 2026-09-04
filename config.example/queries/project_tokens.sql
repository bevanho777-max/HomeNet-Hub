-- project_tokens.sql — read-only PER-PROJECT chat token accounting (§5.5) · NEUTRAL EXAMPLE
--
-- SECURITY: this file is the ONLY source of SQL; the collector never accepts SQL
-- from config or the frontend. This query takes NO bound parameter — i.e. ZERO
-- injection surface. It passes the same door as every other query: resolved
-- strictly from queries/ , read-only, statement_timeout enforced.
--
-- WHY NO PARAMETER: the 7d / 30d windows below are part of the card's meaning
-- (fixed reporting windows), not user input, so they are literals rather than a
-- bound $1. The collector's param-less mode (collectSqlRows with no paramInt) is
-- the documented shape for exactly this case.
--
-- COST: LiteLLM's daily aggregate table holds one row per
-- (date × user_id × api_key × model × provider) — a few hundred rows for a
-- home-lab gateway — so the full scan here is cheap. The card polls it slowly
-- anyway (interval: 5m in targets.yaml).
--
-- WHAT "PROJECT" MEANS — WHY api_key AND NOT end_user OR user_id:
-- LiteLLM offers three candidate identities, and only one of them is both
-- readable with a single grant and filled in by default:
--   • user_id  (this table)  = the owner of the key. Everything on the proxy
--                              master key collapses into one row.
--   • end_user (LiteLLM_DailyEndUserSpend) = the OpenAI `user` request field.
--                              Precise, but ONLY populated for clients that
--                              actually send `user` — most send nothing.
--   • api_key  (this table)  = which key the request came in on. Always
--                              populated, needs no client cooperation, and it
--                              is what you control when you hand a project its
--                              own credential.
-- This query groups by api_key: a project gets its own row the moment it gets
-- its own key, with no change on the client beyond the credential it already
-- has to configure.
--
-- READABLE NAMES ARE DELIBERATELY NOT JOINED HERE. LiteLLM keeps key_alias in
-- LiteLLM_VerificationToken, which a read-only role needs a SEPARATE grant for.
-- Two reasons this file does not depend on it:
--   1. The proxy master key is a config literal, not a minted key — it has NO
--      row in that table and never will, so the join cannot name the one key
--      that usually carries most of the traffic.
--   2. Until a deployment actually mints per-project keys, the join names
--      nothing that the short hash below does not already distinguish.
-- Once you have ≥2 real keys in play, add the grant and swap the label
-- expression for COALESCE(v.key_alias, <the CASE below>) with
--   LEFT JOIN "LiteLLM_VerificationToken" v ON v.token = d.api_key
--   GRANT SELECT ON TABLE "LiteLLM_VerificationToken" TO <readonly_role>;
--
-- WHY EMBEDDINGS ARE EXCLUDED: embedding/rerank traffic (RAG indexing, WebUI
-- document ingest) is machine-generated, enormous in REQUEST count and trivial
-- in TOKEN count — on this gateway it is >99% of requests but <0.1% of tokens.
-- Leaving it in makes the "requests" column meaningless as a measure of what a
-- project actually costs, and lets one re-index run dwarf every real chat. This
-- card is about conversational model usage, so those models are filtered out.
-- The patterns are a LIST so you can extend it: add a row for any embedding or
-- reranker family your gateway serves. Matching is case-insensitive LIKE against
-- the full model string, which is why each pattern is wrapped in %…%.
--
-- ADAPT table/column names. LiteLLM ships "LiteLLM_DailyUserSpend"(api_key text,
--   date text, model text, prompt_tokens bigint, completion_tokens bigint,
--   api_requests bigint, ...).

WITH excluded_models(pattern) AS (
  VALUES
    ('%embed%'),    -- catch-all: text-embedding-*, mxbai-embed-*, nomic-embed-*, …
    ('%bge%'),      -- BAAI/bge-* embedding family (name carries no "embed")
    ('%gte-%'),     -- Alibaba GTE embedding family (hyphen keeps it off chat names)
    ('%rerank%')    -- cross-encoder rerankers: same machine-traffic story
),
chat AS (
  SELECT
    d.api_key                                       AS raw_key,
    d.date::date                                    AS day,
    (d.prompt_tokens + d.completion_tokens)::bigint AS tokens,
    d.api_requests::bigint                          AS requests
  FROM "LiteLLM_DailyUserSpend" d
  WHERE NOT EXISTS (
    SELECT 1 FROM excluded_models x WHERE lower(d.model) LIKE x.pattern
  )
),
labelled AS (
  SELECT
    CASE
      -- LiteLLM's own sentinel for "came in on the configured master key". It is
      -- a config literal, not a minted key, so it has no alias anywhere.
      WHEN raw_key = 'litellm_proxy_master_key' THEN '(master key)'
      -- A real minted key is stored as a 64-char sha256 hex digest. Eight hex
      -- chars is 4 billion values — plenty to tell a home lab's keys apart, and
      -- it keeps the full digest off the screen.
      WHEN raw_key ~ '^[0-9a-f]{64}$'            THEN 'key:' || left(raw_key, 8)
      -- Anything else is a literal somebody typed: health-check pseudo-keys,
      -- probes, junk from a scanner. Show it truncated rather than dropping it,
      -- so unexplained traffic stays visible instead of silently vanishing.
      WHEN COALESCE(raw_key, '') = ''            THEN '(unattributed)'
      ELSE left(raw_key, 16)
    END AS project,
    day, tokens, requests
  FROM chat
)
SELECT
  project,
  COALESCE(SUM(tokens),   0)::bigint                                      AS tokens_total,
  COALESCE(SUM(requests), 0)::bigint                                      AS requests_total,
  COALESCE(SUM(tokens) FILTER (WHERE day > CURRENT_DATE - 7),  0)::bigint AS tokens_7d,
  COALESCE(SUM(tokens) FILTER (WHERE day > CURRENT_DATE - 30), 0)::bigint AS tokens_30d,
  MIN(day)::text                                                          AS first_day,
  MAX(day)::text                                                          AS last_day
FROM labelled
GROUP BY project
-- Drop keys that produced no chat tokens at all. On an internet-facing gateway
-- these are rejected probes and scanner noise — dozens of rows that would bury
-- the handful that represent real projects. They are failures, not usage.
HAVING SUM(tokens) > 0
ORDER BY tokens_total DESC;
