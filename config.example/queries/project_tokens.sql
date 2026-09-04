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
-- COST: LiteLLM's daily aggregate tables hold one row per
-- (date × identity × api_key × model × provider) — a few hundred rows for a
-- home-lab gateway — so the full scan here is cheap. The card polls it slowly
-- anyway (interval: 5m in targets.yaml).
--
-- WHAT "PROJECT" MEANS — WHY THIS TABLE AND NOT LiteLLM_DailyUserSpend:
-- LiteLLM keeps two different notions of "who":
--   • user_id   (LiteLLM_DailyUserSpend)     = the OWNER OF THE API KEY.
--   • end_user  (LiteLLM_DailyEndUserSpend)  = the OpenAI `user` field sent in
--                                              the request body.
-- Verified against a live gateway: a call sent with user:"test-proj" produced a
-- row HERE and nothing at all in DailyUserSpend. Attribution by key owner
-- collapses every caller that shares one key (e.g. everything on the proxy
-- master key) into a single row, so this card reads the end-user table: a client
-- opts into its own row simply by passing `user: "<project>"`.
--
-- A read-only role needs its own grant for this table — it is NOT covered by a
-- grant on LiteLLM_DailyUserSpend:
--   GRANT SELECT ON TABLE "LiteLLM_DailyEndUserSpend" TO <readonly_role>;
--
-- EXPECT AN EMPTY OR ONE-ROW CARD AT FIRST: rows only exist for clients that
-- actually send `user`. Nothing to fix — the receiving end is simply in place
-- ahead of the callers.
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
-- ADAPT table/column names. LiteLLM ships "LiteLLM_DailyEndUserSpend"(
--   end_user_id text, date text, model text NULL, prompt_tokens bigint,
--   completion_tokens bigint, api_requests bigint, ...). Note the column is
--   end_user_id here, while the sibling table spells its identity user_id.

WITH excluded_models(pattern) AS (
  VALUES
    ('%embed%'),    -- catch-all: text-embedding-*, mxbai-embed-*, nomic-embed-*, …
    ('%bge%'),      -- BAAI/bge-* embedding family (name carries no "embed")
    ('%gte-%'),     -- Alibaba GTE embedding family (hyphen keeps it off chat names)
    ('%rerank%')    -- cross-encoder rerankers: same machine-traffic story
),
chat AS (
  SELECT
    -- An absent end_user is a real state (client sent no `user`), not a missing
    -- row; give it a visible bucket instead of dropping or NULL-ing it.
    COALESCE(NULLIF(d.end_user_id, ''), '(unattributed)') AS project,
    d.date::date                                          AS day,
    (d.prompt_tokens + d.completion_tokens)::bigint       AS tokens,
    d.api_requests::bigint                                AS requests
  FROM "LiteLLM_DailyEndUserSpend" d
  -- model is nullable in this table. A NULL model matches no pattern, so
  -- NOT EXISTS keeps the row: an unrecognized model counts as chat rather than
  -- being silently dropped from someone's total.
  WHERE NOT EXISTS (
    SELECT 1 FROM excluded_models x WHERE lower(d.model) LIKE x.pattern
  )
)
SELECT
  project,
  COALESCE(SUM(tokens),   0)::bigint                                      AS tokens_total,
  COALESCE(SUM(requests), 0)::bigint                                      AS requests_total,
  COALESCE(SUM(tokens) FILTER (WHERE day > CURRENT_DATE - 7),  0)::bigint AS tokens_7d,
  COALESCE(SUM(tokens) FILTER (WHERE day > CURRENT_DATE - 30), 0)::bigint AS tokens_30d,
  MIN(day)::text                                                          AS first_day,
  MAX(day)::text                                                          AS last_day
FROM chat
GROUP BY project
ORDER BY tokens_total DESC;
