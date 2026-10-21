# Service-account auth for team rollouts

How a team writes to one shared table without giving every person write
access to it, and without keeping long-lived keys in configuration files.
The mod gets each access token by running its `accessTokenCommand` option, a
command with no shell that prints a token (see the README's
[Authentication](../README.md#authentication)). Each option below is a
different command, or a different grant.

| Option | Who BigQuery sees | Secret on each machine | Access is removed by | Use it for |
| --- | --- | --- | --- | --- |
| [1. Service-account impersonation](#1-service-account-impersonation-recommended) (recommended) | One writer service account | None: each person's own gcloud sign-in | Taking the person out of a group | Teams |
| [2. Group access](#2-group-access-with-each-persons-own-credentials) | Each person | None: each person's own gcloud sign-in | Taking the person out of a group | Small teams, or when BigQuery should see each person |
| [3. Key file](#3-a-key-file-ci-and-headless-machines-only) (discouraged) | One service account | A long-lived private key | Deleting the key | CI and headless machines with no other way in |

In every option the person's sessions keep working when a token cannot be
had: the mod shows a notice, and rows wait on disk until a token works.

## 1. Service-account impersonation (recommended)

One service account may insert rows into the events table, and nothing
else. People may only ask Google for short-lived tokens of that account
(`roles/iam.serviceAccountTokenCreator`), granted to a Google group. Nobody
holds table access or a key, and taking someone out of the group ends their
access.

### What the administrator does

[`setup.sh`](../setup.sh) does it all with `--service-account`:

```bash
BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics \
  ./setup.sh --service-account bqaa-writer --token-creator group:bqaa-users@example.com
```

Besides the dataset, table and views, it creates, or finds:

1. the service account `bqaa-writer@my-gcp-project.iam.gserviceaccount.com`;
2. the project's custom role `bqaaRowWriter`, with two permissions
   (see [What a writer needs](#what-a-writer-needs));
3. that role for the service account, on the events table alone;
4. `roles/iam.serviceAccountTokenCreator` on the service account, for each
   `--token-creator` member (`group:`, `user:` or `serviceAccount:`; repeat
   the flag for more).

It is safe to run again, and `--dry-run` prints the commands without running
them. It needs `gcloud` and `bq`, signed in as someone who may create
service accounts, custom roles, datasets and tables and set their IAM
policies: project Owner, or Service Account Admin, Role Administrator,
BigQuery Data Owner and BigQuery Job User. The commands it runs, to do the
same by hand:

```bash
gcloud iam service-accounts create bqaa-writer --project=my-gcp-project \
  --display-name="BigQuery Agent Analytics mod writer"
gcloud iam roles create bqaaRowWriter --project=my-gcp-project \
  --title="BigQuery Agent Analytics row writer" \
  --permissions=bigquery.tables.get,bigquery.tables.updateData --stage=GA
bq --project_id=my-gcp-project add-iam-policy-binding \
  --member=serviceAccount:bqaa-writer@my-gcp-project.iam.gserviceaccount.com \
  --role=projects/my-gcp-project/roles/bqaaRowWriter \
  my-gcp-project:agent_analytics.agent_events
gcloud iam service-accounts add-iam-policy-binding \
  bqaa-writer@my-gcp-project.iam.gserviceaccount.com --project=my-gcp-project \
  --member=group:bqaa-users@example.com --role=roles/iam.serviceAccountTokenCreator
```

New grants can take a minute or two to apply. Until they do, the token
command fails and the mod shows the credentials notice; the rows wait and
are sent once it works.

### What each person does

1. Sign in to gcloud once, as themselves: `gcloud auth login`. Impersonation
   uses gcloud's own sign-in, not the Application Default Credentials that
   `gcloud auth application-default login` sets up.
2. Set the mod's `accessTokenCommand` option:

   ```text
   gcloud auth print-access-token --impersonate-service-account=bqaa-writer@my-gcp-project.iam.gserviceaccount.com
   ```

   At install time that is one more `--config` (the value is one argument):

   ```bash
   claude plugin install bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin \
     --config project=my-gcp-project --config dataset=agent_analytics \
     --config "accessTokenCommand=gcloud auth print-access-token --impersonate-service-account=bqaa-writer@my-gcp-project.iam.gserviceaccount.com"
   ```

   For an installed copy, `/plugin configure` (or `claude plugin configure`)
   sets it. An administrator can set it for everyone with managed settings
   instead.

### Check it

- `/bqaa-status` shows `enabled, target my-gcp-project.agent_analytics.agent_events`
  and, after the first send (every 5 seconds), `sent` above 0 and a
  `last success` time.
- The rows are there:

  ```bash
  bq --project_id=my-gcp-project query --use_legacy_sql=false \
    'SELECT user_id, event_type, timestamp FROM `my-gcp-project.agent_analytics.agent_events`
     WHERE timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR) ORDER BY timestamp DESC LIMIT 10'
  ```

### `user_id` under impersonation

Keep `userIdFromCredentials` off (its default). Then `user_id` is the
person's login name (`$USER`, or `BQAA_USER_ID`), so rows still tell people
apart, although BigQuery sees only the service account. With
`userIdFromCredentials` on, the mod looks up the token's account, which is
now the service account: every row's `user_id` becomes
`bqaa-writer@my-gcp-project.iam.gserviceaccount.com`.

`user_id` is what the person's machine says. BigQuery checks who may insert,
not what a row contains, and keeps no audit-log entry per streaming insert.
Google's IAM can record who asked for each service-account token when Data
Access audit logs are on for the IAM Service Account Credentials API; that
names the person behind the service account, though not row by row.

Google also documents impersonation through Application Default Credentials
(`gcloud auth application-default login --impersonate-service-account=...`),
which leaves the mod's default token command as it is. It was not tried with
the mod; the `--impersonate-service-account` command above was.

## 2. Group access with each person's own credentials

Give a Google group the right to insert rows, and keep the mod's default
token command (`gcloud auth application-default print-access-token`). Each
person signs in once with `gcloud auth application-default login`. Rows are
inserted as each person, and `userIdFromCredentials` gives each person's own
verified email.

Grant the narrow role on the table to the group (the role from option 1;
`setup.sh --service-account` creates it, or create it with the
`gcloud iam roles create` command above):

```bash
bq --project_id=my-gcp-project add-iam-policy-binding \
  --member=group:bqaa-users@example.com \
  --role=projects/my-gcp-project/roles/bqaaRowWriter \
  my-gcp-project:agent_analytics.agent_events
```

`roles/bigquery.dataEditor` on the dataset also works, and is what one
person needs on a sandbox of their own. For a shared table it is too much:
it can read every row (everyone's prompts and tool output), and create and
delete tables.

## 3. A key file (CI and headless machines only)

Discouraged. A service-account key is a long-lived secret: anyone who copies
the file can insert rows until the key is deleted, and every copy has to be
replaced when it is rotated. On CI, prefer workload identity federation;
where it is used, the token comes from gcloud the same way.

The mod cannot use a key file directly: it has no way to sign the token
request. Wrap it in a token command that reads the key through Application
Default Credentials, with the variable set for that command alone:

```text
env GOOGLE_APPLICATION_CREDENTIALS=/secure/path/bqaa-writer-key.json gcloud auth application-default print-access-token
```

- Create the key with `gcloud iam service-accounts keys create
  /secure/path/bqaa-writer-key.json --iam-account=bqaa-writer@my-gcp-project.iam.gserviceaccount.com`,
  keep it readable by the machine's account only, and never commit it.
- Rotate it: create a new key, put it in place, then delete the old one with
  `gcloud iam service-accounts keys delete KEY_ID --iam-account=...`.
- `BQAA_ACCESS_TOKEN` takes a token as it is instead, for a short job that
  gets one some other way (it is read again every 5 minutes).

## What a writer needs

Inserting rows with `insertAll`, which the mod does, takes two permissions
on the table:

- `bigquery.tables.updateData`, to insert rows;
- `bigquery.tables.get`. Streaming inserts check it too: without it BigQuery
  answers `403 ... Permission bigquery.tables.get denied on table`.

The custom role `bqaaRowWriter` holds exactly these two, granted on the
events table alone, so the writer can insert rows into that table and read
none. Google's documentation also lists `bigquery.datasets.get` on the
dataset for `insertAll`; the table-level pair was enough when this guide was
checked. If BigQuery ever asks for it, grant `roles/bigquery.metadataViewer`
on the dataset, which reads table names and schemas, not rows.

With this role the writer cannot create the table: create it with
`setup.sh`, which also builds the views. If the table is missing, the mod's
attempt to create it is refused, and the mod shows the "BigQuery cannot find
the table" notice with the `setup.sh` command; rows wait until the table is
there. To skip that attempt, set `BQAA_AUTO_CREATE_TABLE=false`.

People who read the results need none of this. They read the views:
`roles/bigquery.dataViewer` on the views dataset (`<dataset>_reporting`) and
`roles/bigquery.jobUser` on a project, with the views authorized on the
events dataset so that readers need no access to the table.

## If rows are not written

- **"no working Google credentials"**: the token command fails. Run it by
  hand to see why: not signed in (`gcloud auth login`), no
  `roles/iam.serviceAccountTokenCreator` on the service account, or a grant
  made moments ago that has not applied yet.
- **"BigQuery denied the identity access to the dataset"**: BigQuery refused
  the insert. The identity (the service account, for option 1) needs
  `roles/bigquery.dataEditor` on the dataset, or `bqaaRowWriter` (or the two
  permissions) on the table. Then run `/bqaa-backfill` to send the refused
  rows.
- **"BigQuery cannot find the table"**: run the `setup.sh` command the
  notice shows.
