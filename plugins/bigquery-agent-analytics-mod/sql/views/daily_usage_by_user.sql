-- Sessions, model requests and tokens per day and user, from the mod's
-- LLM_RESPONSE rows, one row per event_id. `user_id` is BQAA_USER_ID or the
-- login name, or with the userIdFromCredentials option the verified account
-- of the token. setup.sh fills in {PROJECT}, {DATASET}, {TABLE} and
-- {VIEWS_DATASET}.
--
-- Filter on `day`: duplicates are matched within one timestamp, so a filter
-- on the date still reaches the table's day partitions.
CREATE OR REPLACE VIEW `{PROJECT}.{VIEWS_DATASET}.daily_usage_by_user`
OPTIONS (description = 'Sessions, model requests and tokens per day and user, from the agent_events LLM_RESPONSE rows, one per event_id.')
AS
WITH responses AS (
  SELECT
    timestamp,
    user_id,
    session_id,
    SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.input_tokens') AS INT64) AS input_tokens,
    SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.cache_read_input_tokens') AS INT64) AS cache_read_input_tokens,
    SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.cache_creation_input_tokens') AS INT64) AS cache_creation_input_tokens,
    SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.output_tokens') AS INT64) AS output_tokens,
    SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.total_tokens') AS INT64) AS total_tokens
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type = 'LLM_RESPONSE'
  -- A row sent twice (after an ambiguous timeout, or by a replay) has the
  -- same event_id and timestamp: keep one.
  QUALIFY event_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY timestamp, event_id) = 1
)
SELECT
  DATE(timestamp) AS day,
  COALESCE(user_id, '(unknown)') AS user_id,
  COUNT(DISTINCT session_id) AS sessions,
  COUNT(*) AS model_requests,
  SUM(input_tokens) AS input_tokens,
  SUM(cache_read_input_tokens) AS cache_read_input_tokens,
  SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(total_tokens) AS total_tokens
FROM responses
GROUP BY day, user_id;
