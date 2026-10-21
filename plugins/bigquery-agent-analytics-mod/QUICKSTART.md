# Quickstart

The mod records each coding-agent session (prompts, model requests with
tokens and latency, tool calls) as rows in a BigQuery table. Two paths:

- [For you](#for-you-about-5-minutes): record your own sessions, in about
  five minutes.
- [For a team](#for-a-team): set up the table and access once, then roll it
  out.

The [README](README.md) is the reference: every option, how it works,
privacy, and the limits.

## For you (about 5 minutes)

### 1. What you need

- The host CLI at version 2.1.292 or later (`claude --version`).
- The Google Cloud CLI (`gcloud`, which includes `bq`).
- A BigQuery dataset you may write to: a project and dataset name from your
  administrator, or a sandbox project of your own. With your own project,
  first make the dataset with step 1 of [For a team](#for-a-team).

### 2. Sign in to Google Cloud

```bash
gcloud auth application-default login
```

If your administrator gave you a token command (a writer service account),
sign in with `gcloud auth login` instead, and pass that command at step 3.

### 3. Install the mod

```bash
claude plugin install bigquery-agent-analytics-mod \
  --marketplace haiyuan-eng-google/bigquery_agent_analytics_skill \
  --config project=YOUR_PROJECT --config dataset=YOUR_DATASET
```

With a token command from your administrator, add
`--config "accessTokenCommand=THE COMMAND"`. It may add that other options
are not set yet: they all have defaults. If a session is already open, run
`/reload-plugins` there, or start a new one.

### 4. Check that it is on

Start a session (`claude`). In the first session after the install, a card
above the prompt says the mod is installed and names your table; a few
seconds later it says the first rows landed in BigQuery.

- `/plugin` lists `1 mod active · bigquery-agent-analytics-mod`.
- `/bqaa-status` starts with
  `BigQuery Agent Analytics mod: enabled, target YOUR_PROJECT.YOUR_DATASET.agent_events`,
  has no `notice` line, and after the first send (every 5 seconds) shows
  `requests: 1 ok` or more.

### 5. See your rows

Type one prompt, for example "list the files here". Then, in a shell:

```bash
bq --project_id=YOUR_PROJECT query --use_legacy_sql=false \
  'SELECT event_type, COUNT(*) AS n
   FROM `YOUR_PROJECT.YOUR_DATASET.agent_events`
   WHERE timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
     AND JSON_VALUE(attributes, "$.writer.plugin") = "bigquery-agent-analytics-mod"
   GROUP BY event_type ORDER BY n DESC'
```

You see `USER_MESSAGE_RECEIVED` for the prompt, `INVOCATION_STARTING` and
`INVOCATION_COMPLETED` around the turn, `LLM_REQUEST` and `LLM_RESPONSE`
for the model's requests, `AGENT_RESPONSE` for its answer, `TOOL_STARTING`
and `TOOL_COMPLETED` if a tool ran, and `STATE_DELTA` for the session's
start. The session's end is written to disk when you leave, and sent by
your next session.

### 6. If rows are not written

The status line under the prompt, the band above it and `/bqaa-status` say
why, and how to fix it. Rows wait on your disk meanwhile, and are sent once
it is fixed.

| It says | What to do |
| --- | --- |
| BigQuery cannot find the dataset | Check the project and dataset names with your administrator, or make the dataset: the notice prints the whole `setup.sh` command, ready to run. BigQuery can take a few minutes to see a new dataset; the rows are sent on their own then. |
| BigQuery denied the identity access to the dataset | Ask for the access the notice names, then run `/bqaa-backfill` to send the rows that were refused. |
| no working Google credentials | Sign in again (`gcloud auth application-default login`), or fix what the notice says about your token command. |

## For a team

1. **Make the dataset and table** with the mod's `setup.sh` (it uses `bq`,
   and also makes a views dataset, `<dataset>_reporting`, with two usage
   views):

   ```bash
   git clone https://github.com/haiyuan-eng-google/bigquery_agent_analytics_skill
   BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics \
     ./bigquery_agent_analytics_skill/plugins/bigquery-agent-analytics-mod/setup.sh
   ```

2. **Pick how people authenticate.**
   [Service-account auth](docs/service-account-auth.md) covers a writer
   service account that people impersonate (recommended: no key on any
   machine, and nobody holds table access; `setup.sh --service-account`
   sets it up), group access with each person's own credentials, and key
   files for CI.
3. **Grant access to a Google group**, not to individual people: Token
   Creator on the writer account (`setup.sh --token-creator group:...`), or
   the row-writer role on the table. Taking someone out of the group ends
   their access.
4. **Roll it out.** Give people the project, dataset and token command for
   [For you](#for-you-about-5-minutes), or turn the mod on for everyone with
   [managed settings](docs/managed-settings.md): nobody installs anything,
   and the table and token command are pinned.
5. **Point people at the results.**
   - The views in `<dataset>_reporting`: `daily_usage_by_user` and
     `daily_usage_by_model`. Readers need `roles/bigquery.dataViewer` on
     that dataset and `roles/bigquery.jobUser`, and no access to the table.
   - The analysis skill in this repository
     ([`bigquery-agent-analytics-skill/`](../../bigquery-agent-analytics-skill/SKILL.md)),
     which a coding agent can use to answer questions about error rates,
     latency, token use and tool failures from the table.
   - The ready-made queries in [`sql/sample_queries.sql`](sql/sample_queries.sql).
