# Turn the mod on for a team with managed settings

For the administrator who deploys the host CLI's managed settings. One
policy file turns the mod on for everyone who gets it, writing to one
BigQuery table, with options people cannot change.

What a policy does not do:

- **It provisions no credentials.** Each person still installs the Google
  Cloud CLI and signs in once (see [What each person needs](#3-what-each-person-needs)).
- **It cannot enforce capture on a machine its user controls.** Safe mode,
  bare mode, other tools and administrator rights on the machine all get
  around it (see [What a person can and cannot change](#4-what-a-person-can-and-cannot-change)).
- **It does not make attribution proof.** `user_id` is what the machine
  says.

## Before it goes beyond a pilot

Do not deliver the policy to more than a pilot group until each of these is
in place:

1. **The access model** of [service-account auth](service-account-auth.md):
   a writer service account that may only insert rows, readers who see only
   the views, and the project's Viewer and Editor groups off the datasets.
2. **A data-handling sign-off** with a named owner
   ([Data-handling sign-off](#9-data-handling-sign-off)).
3. **Named owners** for the policy: who edits it, who approves a change,
   who delivers it (your device management), and who moves the pinned
   version of the mod.
4. **A pilot plan** with entry and exit criteria
   ([Roll out in stages](#7-roll-out-in-stages)).

## Choose the tier

| | A folder your device management deploys (recommended) | The GitHub marketplace, pinned to a tag |
| --- | --- | --- |
| How the mod runs | As your organization's (`tier prepend` in the debug log) | As a mod the person installed (`tier user`, "not read in place from a local folder") |
| A fresh machine records | From its first session | From its second or third session, or from the first after one install from the pinned source |
| Under `allowManagedModsOnly` | Loads | Refused |
| Under `allowManagedHooksOnly` | Loads | Not loaded |
| A person's `enabledPlugins` false, or `plugin uninstall` | No effect | No effect |
| Session-start rows and permission-prompt flags | Recorded | Not recorded, and subagent starts are inferred: on a managed machine those events pass over a mod in the user tier (the README's Limitations) |
| What you deliver | A folder and the policy | The policy only |
| The version | The archive you copied, checked by its checksum | A tag, with `autoUpdate` off |

Choose the folder wherever your device management can deliver files.

## 1. The marketplace folder

Put the folder on every machine at the same absolute path, owned by an
administrator and writable by nobody else (the folder and every folder
above it):

```text
/opt/org/agent-plugins/
├── .claude-plugin/marketplace.json
└── plugins/bigquery-agent-analytics-mod/
```

`marketplace.json`:

```json
{
  "name": "org-tools",
  "owner": { "name": "Example Org" },
  "plugins": [
    { "name": "bigquery-agent-analytics-mod", "source": "./plugins/bigquery-agent-analytics-mod" }
  ]
}
```

Copy the mod from a commit you reviewed, as an archive with a checksum, so
every machine runs the same files:

```bash
# Once, from a checkout of this repository, at the commit you reviewed:
git archive --format=tar.gz -o bqaa-mod-COMMIT.tar.gz COMMIT plugins/bigquery-agent-analytics-mod
shasum -a 256 bqaa-mod-COMMIT.tar.gz    # record it with the commit
# On each machine, by device management, after checking the checksum:
tar -xzf bqaa-mod-COMMIT.tar.gz --strip-components=1 -C /opt/org/agent-plugins/plugins
```

A new version is a new archive, reviewed and approved the same way, given
to the pilot group first.

## 2. The policy

The host CLI reads its managed settings from one file per machine:

- Linux and WSL: `/etc/claude-code/managed-settings.json` (checked)
- macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
  (not checked here)
- Windows: `C:\Program Files\ClaudeCode\managed-settings.json` (not checked
  here)

The complete policy for the folder. Set every option: an option the policy
leaves out is the person's (their own value, or the environment's).

```json
{
  "extraKnownMarketplaces": {
    "org-tools": { "source": { "source": "directory", "path": "/opt/org/agent-plugins" } }
  },
  "enabledPlugins": {
    "bigquery-agent-analytics-mod@org-tools": true,
    "bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin": false,
    "bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin": false,
    "bigquery-agent-analytics-tracing@bqaa-tracing": false
  },
  "pluginConfigs": {
    "bigquery-agent-analytics-mod@org-tools": {
      "options": {
        "project": "my-gcp-project",
        "dataset": "agent_analytics",
        "table": "agent_events",
        "location": "US",
        "enabled": true,
        "dryRun": false,
        "accessTokenCommand": "/usr/bin/gcloud auth print-access-token --impersonate-service-account=bqaa-row-writer@my-gcp-project.iam.gserviceaccount.com",
        "deadLetterDir": "",
        "agentName": "coding-agent",
        "maxPayloadChars": 16384,
        "flushIntervalMs": 5000,
        "userIdFromCredentials": false,
        "recordHostname": false
      }
    }
  },
  "env": {
    "BQAA_TRACE_ENABLED": "true",
    "BQAA_DRY_RUN": "false",
    "BQAA_ACCESS_TOKEN": "",
    "BQAA_DEAD_LETTER_DIR": "",
    "BQAA_USER_ID": "",
    "BQAA_AUTO_CREATE_TABLE": "false",
    "BQAA_AUTO_BACKFILL": "true"
  }
}
```

| Entry | What it does |
| --- | --- |
| `extraKnownMarketplaces` | Names the folder that holds the marketplace |
| `enabledPlugins` | Turns the mod on for everyone who gets the policy, and turns off the earlier ways in: the mod under its old marketplace id, and the settings-hook tracer from either marketplace (see [Moving from the settings-hook tracer](#5-moving-from-the-settings-hook-tracer-or-an-earlier-install)). A `false` here also refuses a new install of that plugin |
| `options.project`, `dataset`, `table`, `location` | The destination. The person's own options, a `--settings` file and `BQAA_PROJECT_ID`, `BQAA_DATASET`, `BQAA_TABLE` or `BQ_TABLE` in their shell or a repository's settings change nothing |
| `options.enabled`, `dryRun` and `env` `BQAA_TRACE_ENABLED`, `BQAA_DRY_RUN` | Capture on, and rows really sent. These two switches also read the environment: without the `env` pins, a shell or a repository's settings turn capture off or a dry run on |
| `options.accessTokenCommand` and `env` `BQAA_ACCESS_TOKEN: ""` | How tokens are had: here, impersonation of the writer service account. No token from the environment instead. Name gcloud by its absolute path on your machines: a session started from a desktop app or an editor may not have the shell's `PATH` |
| `options.deadLetterDir: ""` and `env` `BQAA_DEAD_LETTER_DIR: ""` | Rows that wait stay in each person's home folder (`~/.bqaa-mod/dead-letter`), not in a folder the person, a `--settings` file or a repository's settings name (a repository could otherwise put them in its working tree, where a commit could take them). A pinned `~/...` would not be expanded, hence the empty value |
| `options.agentName`, `maxPayloadChars`, `flushIntervalMs` | The `agent` column, how much of each payload is kept, and how often rows are sent |
| `options.userIdFromCredentials: false` and `env` `BQAA_USER_ID: ""` | `user_id` is each person's login name. Under impersonation, `userIdFromCredentials` would make every row's `user_id` the service account |
| `options.recordHostname: false` | No machine names in the rows |
| `env` `BQAA_AUTO_CREATE_TABLE: "false"` | People's credentials never try to create the table: `setup.sh` made it |
| `env` `BQAA_AUTO_BACKFILL: "true"` | Rows that waited are sent at session start once tokens work |

Left to each person, as they change when rows are sent and not where:
`BQAA_REQUEST_TIMEOUT_MS`, `BQAA_MAX_QUEUE_ROWS` and `BQAA_EXIT_FLUSH_MS`.

To check a machine: `claude -p /bqaa-status` (no model call) prints
`enabled, target my-gcp-project.agent_analytics.agent_events (US)`, and
`claude -p --debug-file /tmp/bqaa.log /bqaa-status` leaves
`hooks module bigquery-agent-analytics-mod@org-tools loaded (... tier prepend)`
in the log.

## 3. What each person needs

- **The Google Cloud CLI, signed in once** as themselves
  (`gcloud auth login`), and membership of the group allowed to impersonate
  the writer ([service-account auth](service-account-auth.md)). The policy
  cannot sign anyone in. Until they do, their sessions show "no working
  Google credentials" and keep rows on disk.
- **gcloud at the path the policy names.** Install it at the same path on
  every machine, or deliver a policy per platform.
- **A tested host CLI.** This guide was checked with host CLI 2.1.304.
- **Windows: not checked.** The token command runs with no shell, and
  gcloud on Windows is a `.cmd` script, which may not start that way.

The network the mod and its token command reach:

| Host | For |
| --- | --- |
| `bigquery.googleapis.com` | Inserting rows |
| `iamcredentials.googleapis.com` | Impersonated tokens |
| `oauth2.googleapis.com` | gcloud's token refresh, and the account lookup of `userIdFromCredentials` |
| `accounts.google.com` | The one-time `gcloud auth login` |
| `github.com` | The GitHub variant only: fetching the marketplace |

## 4. What a person can and cannot change

What each person can try, with the folder policy above; each row is a
check in [`tests/managed-settings.live.sh`](../tests/managed-settings.live.sh):

| A person who... | Result |
| --- | --- |
| Sets their own options or uses a `--settings` file (another dataset or table, capture off, a dry run, a folder, an agent name, the identity options, another token command) | No effect |
| Sets `BQAA_*` variables in their shell or a repository's settings | No effect on the pinned ones |
| Sets `enabledPlugins` false, or runs `claude plugin disable` or `claude plugin uninstall` (with or without `--scope managed`) | No effect: the uninstall is refused |
| Starts the host with `--safe-mode`, `CLAUDE_CODE_SAFE_MODE=1` or `--bare` | No plugin loads, yours included: that session records nothing |
| Sets `USER` in their shell or a repository's settings | `user_id` changes: the login name is what the machine says |
| Uses another tool, or edits the policy with administrator rights on the machine | Not covered by a policy |
| Inserts rows of their own with the writer's tokens | Possible ([service-account auth](service-account-auth.md)) |

Capture cannot be fully enforced on a machine its user controls. Treat the
table as a record of the sessions that ran with the mod, not of all of
them.

**To let people opt out**, leave `enabled` and `BQAA_TRACE_ENABLED` out of
the policy: their own `enabled: false` (`/plugin configure`) or a shell's
`BQAA_TRACE_ENABLED=false` then turns capture off (checked: without the
`env` pins, the shell turns it off).

**Fleet-wide locks**, which apply to every plugin, not just this one:

- `allowManagedModsOnly`, an option of the built-in security plugin:
  `"pluginConfigs": { "cc-plugin-sec-default@builtin": { "options": { "allowManagedModsOnly": true } } }`.
  Mods load only from your organization: the folder mod loads, a copy from
  GitHub is refused. Settings hooks still run.
- `"allowManagedHooksOnly": true`: only managed plugins' hooks run. The
  folder mod loads; a copy from GitHub, people's own plugins and the hooks
  in their settings files do not.

## 5. Moving from the settings-hook tracer or an earlier install

People who used the settings-hook tracer, or installed the mod from the
GitHub marketplace, keep that install when the policy arrives. Checked in a
container:

- **The tracer keeps writing** beside the mod (every event twice) until the
  policy turns it off. `allowManagedModsOnly` does not stop it.
- **With its id `false` in `enabledPlugins`** (as in the policy above) it
  runs no hook, and a new install of it is refused. So does
  `allowManagedHooksOnly`, for every person's plugins.
- **The mod under its old id** never loads beside your organization's ("another
  plugin of that name loads first"). The policy turns it off anyway, for a
  machine without the folder.

The settings-hook recipe from the earlier guide (hooks pasted into a
person's own `settings.json`) has no plugin id to turn off: ask people to
remove it, or set `allowManagedHooksOnly`. To find people still writing
twice, see the query in [Roll out in stages](#7-roll-out-in-stages).

## 6. Without a folder: the GitHub marketplace, pinned

Where you can deliver settings but not files, name the GitHub marketplace,
pinned to a tag, with `autoUpdate` off:

```json
{
  "extraKnownMarketplaces": {
    "bigquery-agent-analytics-plugin": {
      "source": { "source": "github", "repo": "haiyuan-eng-google/bigquery_agent_analytics_skill", "ref": "TAG" },
      "autoUpdate": false
    }
  },
  "enabledPlugins": {
    "bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin": true,
    "bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin": false,
    "bigquery-agent-analytics-tracing@bqaa-tracing": false
  },
  "pluginConfigs": {
    "bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin": {
      "options": { "...": "every option, as in the folder policy" }
    }
  },
  "env": { "...": "the same pins as the folder policy" }
}
```

Checked in a container, against a test tag:

- The copy each machine installs is the tag's, not the default branch's,
  and `autoUpdate` stays off.
- The policy's options hold against the person's own.
- A fresh machine records nothing in its first session, which registers
  the marketplace and installs the mod in the background. The mod records
  from the next session after that install: the second, when the first
  stayed open (20 seconds, in a check), otherwise the third. To record from
  the first, have each person (or a setup script run as them) install it
  once from the same pinned source:
  `claude plugin install bigquery-agent-analytics-mod --marketplace "haiyuan-eng-google/bigquery_agent_analytics_skill#TAG"`
  (no `--config`: the policy's options apply).
- It runs in the user tier, with the differences in
  [Choose the tier](#choose-the-tier).

The repository has no release tags for the mod yet. Until it does, use the
folder, or a tag in a fork your organization controls. `ref` takes a branch
or a tag, not a commit. How an installed copy follows a changed `ref` was
not checked: change it for the pilot group first, and check the version
under `~/.claude/plugins/cache/` on a pilot machine.

## 7. Roll out in stages

1. **Entry:** the items in [Before it goes beyond a pilot](#before-it-goes-beyond-a-pilot)
   are done, and the check at the end of [The policy](#2-the-policy)
   passes on one machine with your policy.
2. **Pilot:** deliver the policy to a named group (5 to 20 people) for a
   week. On each machine, after a session, `/bqaa-status` shows `enabled`,
   your target, no `notice` line and `requests: N ok`.
3. **Watch** these, daily:
   - enrolled people with no rows on days they used the agent;
   - people whose rows wait on disk: their `/bqaa-status` shows a notice,
     or rows waiting;
   - rows from the settings-hook tracer (`writer.plugin` =
     `bqaa-coding-agent-plugin`) from enrolled people: events written twice.

   With a table of the enrolled login names (`team_roster`, one `user_id`
   column) that you keep:

   ```sql
   -- Per enrolled person, the last 7 days: sessions, last row, tracer rows.
   WITH seen AS (
     SELECT user_id, COUNT(DISTINCT session_id) AS sessions, MAX(timestamp) AS last_row,
       COUNTIF(JSON_VALUE(attributes, '$.writer.plugin') = 'bqaa-coding-agent-plugin') AS tracer_rows
     FROM `my-gcp-project.agent_analytics.agent_events`
     WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
       AND JSON_VALUE(attributes, '$.writer.plugin') IN ('bigquery-agent-analytics-mod', 'bqaa-coding-agent-plugin')
     GROUP BY user_id
   )
   SELECT r.user_id, IFNULL(s.sessions, 0) AS sessions, s.last_row, IFNULL(s.tracer_rows, 0) AS tracer_rows
   FROM `my-gcp-project.agent_analytics.team_roster` AS r
   LEFT JOIN seen AS s USING (user_id)
   ORDER BY sessions, r.user_id
   ```

   Run it as an administrator: it reads the table, not the views.
4. **Exit**, to widen: every enrolled person who used the agent has rows;
   no tracer rows; no notice left open for a week; the data-handling owner
   has looked at a sample of rows.
5. **Widen** in rings. A policy change reaches each person at their next
   session.

## 8. Stop, roll back, revoke

Checked in a container unless noted:

| To... | Do | What happens |
| --- | --- | --- |
| Stop recording, keep the mod | Policy: `options.enabled: false` and `env` `BQAA_TRACE_ENABLED: "false"` | The mod loads and records nothing (`/bqaa-status`: `disabled`, `captured 0`) |
| Unload the mod at once | Policy: `"bigquery-agent-analytics-mod@org-tools": false` | The mod does not load |
| Roll back | Remove the policy's entries (or the file) and the folder | The mod does not load. Rows that waited stay on disk |
| Revoke the writer's tokens | Disable the writer service account ([service-account auth](service-account-auth.md#offboarding)) | Tokens are refused, issued ones included (a check refused one with `401` within 15 seconds, live). Sessions show "no working Google credentials" and keep rows on disk |

Each takes effect when a session starts.

**Rows that waited** are in each person's
`~/.bqaa-mod/dead-letter/<project.dataset.table>/`. They hold prompts and
tool output, so treat them as personal data on the machine:

- After a rollback they stay (checked).
- With the mod back, `/bqaa-status` lists them (checked), and they are sent
  once tokens work, at session start or with `/bqaa-backfill`.
- To discard them, delete the folder (checked: nothing waits after).
- Include the folder when a machine is wiped or handed on.

## 9. Data-handling sign-off

Fill this in, and have the owner sign it, before the policy goes beyond the
pilot:

| Item | Answer |
| --- | --- |
| What is collected | Each person's prompts, the model's visible answers, tool arguments and results, cut to `maxPayloadChars` per column, with credential-shaped values removed (the README's [Privacy and security](../README.md#privacy-and-security)). Also token counts, latency, tool names and outcomes, the login name as `user_id`, and the working directory |
| Who can read it | Writers cannot. Readers of the views see counts and tokens per day. The administrators, and anyone with a project role that reads every table, see everything ([service-account auth](service-account-auth.md#project-roles-reach-the-table-too)): name them |
| How long it is kept | Set a partition expiration on the table (`ALTER TABLE ... SET OPTIONS (partition_expiration_days = N)`); the mod sets none |
| Where it goes | Only the project and dataset in the policy, over HTTPS to BigQuery. Rows that could not be sent wait in each person's home folder until they are |
| Who was told | How the people whose sessions are recorded were told, and where they can read this |
| Owner | Name, role, date of the decision |

## Checked

[`tests/managed-settings.live.sh`](../tests/managed-settings.live.sh) runs
this guide in a Linux container with host CLI 2.1.304, as an ordinary user
under a root-owned policy: offline for the folder (35 checks), and over the
network for the GitHub variant pinned to a test tag (10 more, with
`BQAA_CHECK_NETWORK=1`). Every row of the tables above marked as checked is
one of its checks.

Not checked:

- the macOS and Windows policy files;
- policies delivered by device-management profiles or an admin console;
- the desktop app and editor extensions (the checks run the CLI);
- Windows token commands;
- how a GitHub copy follows a changed `ref`;
- groups (people stood in for group members).
