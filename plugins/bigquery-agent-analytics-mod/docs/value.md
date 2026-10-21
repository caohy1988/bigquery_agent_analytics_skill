# What the mod gives you

What a developer, a team lead and a platform team can learn from the rows
the mod writes, which query answers each question, who can run it, and what
the numbers cannot tell. The queries are in
[`sql/value_queries.sql`](../sql/value_queries.sql) (V1 to V7) beside the
README's [`sql/sample_queries.sql`](../sql/sample_queries.sql) (1 to 8);
[`tests/queries.live.py`](../tests/queries.live.py) runs every one of them
on a synthetic fixture and checks the answers.

## Who learns what

| Who | The question | Query | Who can run it | What it cannot tell |
| --- | --- | --- | --- | --- |
| Developer | Where did my sessions' time, tokens and tool failures go? | V1 (per session), V2 (per turn), sample 5 (per turn, with the prompt) | Someone who may read the table: you, in your own sandbox project; in a team, an administrator | In a team set up as issue #13's service-account guide recommends, you can write rows and read none. Per-day totals by person are in the views (`daily_usage_by_user`), which a reader group may query |
| Team lead or administrator | Who uses it, against who was enrolled? | V3, with a roster | An administrator | Who did not use the agent and whose sessions were not recorded look the same: both have no rows |
| Team lead or administrator | What does a session cost? | V4, with your rates | An administrator | An estimate: tokens times the rates you enter, dated. Not a bill |
| Team lead or administrator | Which tools do people use, and how often do they fail, prompt, get rejected or get denied? | V5, sample 4 | An administrator | Calls a permission rule blocks before they run may leave no row |
| Team lead or administrator | Are errors going up? | V6, sample 8 | An administrator | Each rate has its own denominator (turns, model requests, tool calls), as V6 shows them |
| Platform team | How do coding-agent sessions compare with our ADK agents? | V7 | An administrator of the shared table | Only sessions, model requests, tokens and error rows are compared; other columns differ by producer |
| Anyone with the views | Sessions, model requests and tokens per day, by person or model | `daily_usage_by_user`, `daily_usage_by_model` | The reader group | No prompts, tools or errors: counts only |

## Denominators

- **Sessions**: distinct `session_id` among the mod's rows in the window,
  each row counted once by `event_id` (a resent row has the same one).
- **People**: `user_id`, the login name each machine reported. It is an
  attribution, not proof: a repository's settings can set `USER`, and
  `BQAA_USER_ID` is read from the environment. Under impersonation keep
  `userIdFromCredentials` off, or every row says the service account and
  everyone is one person.
- **The cohort**: a roster of the people enrolled (a `team_roster` table of
  login names that you keep, as issue #17's pilot does). V3 counts
  each day's enrolled people seen and not seen, and keeps sessions from no
  one on the roster, or with no `user_id`, apart.
- **Errors**: per turn (turns that ended in `INVOCATION_ERROR`), per model
  request (`LLM_ERROR` among answered and failed requests) and per tool call
  (`TOOL_COMPLETED` with status `ERROR`), never one rate over all rows.
- **Missing is not zero**: a person with no rows is "not seen", a turn with
  no recorded end has no duration (NULL), and a model with no rate row has
  no cost (NULL).

## Running a query

Each query reads the raw table, so it runs as someone who may read it, with
the analysis skill's runner. The runner uses your Application Default
Credentials (`gcloud auth application-default login`), not the mod's
settings, fills `{PROJECT}`, `{DATASET}` and `{TABLE}`, binds `@start` and
`@end`, and refuses a query that would bill more than `--max-gb`:

```bash
python3 bigquery-agent-analytics-skill/scripts/run_bq.py \
  --project my-gcp-project --dataset agent_analytics --table agent_events \
  --start 2026-10-01 --end 2026-10-31 --max-gb 1 --dry-run "<one query>"
```

`--dry-run` prints the bytes the query would scan; drop it to run it. The
table is partitioned by day, so the window decides the bytes. On the
fixture each query scanned 3 to 5 KB. V3 also reads `team_roster` in the
same dataset; V4 needs your rates in its `rates` block.

## Cost, as an estimate

V4 multiplies each model's tokens by the rates you put in its `rates`
block: USD per million tokens for uncached input, cache reads, cache writes
and output, with the date and the source of the rates. Cache reads and
writes are priced apart from uncached input, as the tokens are recorded
apart. A model with no rate row shows no cost, and discounts or other
charges are not counted. Keep the rates dated, and re-check them when they
change.

## A dashboard

The views in `<dataset>_reporting` can feed a dashboard tool directly
(Looker Studio, or the SDK's dashboards), for the reader group. A screenshot
for a write-up must come from synthetic or scrubbed data, with the data
owner's approval recorded: the table holds prompts, answers, tool payloads,
working directories and login names.

## A blurb

For docs, posts and partner write-ups, once the mod has a tagged release
(issue #14); its link goes where the bracket is:

> BigQuery Agent Analytics for coding agents is an early-access mod
> (version 0.1.0) that writes each coding-agent session to a BigQuery table
> in the `agent_events` schema of ADK's BigQuery Agent Analytics: prompts,
> the model's answers, tool calls with their arguments and results, token
> counts and timings. Teams can see adoption against who was enrolled,
> estimated cost, and tool failures and denials, and can query their
> coding-agent sessions beside their ADK agents in one table. Because the
> rows hold prompt and tool content, its setup gives writers insert-only
> access and readers aggregate views. Install it from [the release].
