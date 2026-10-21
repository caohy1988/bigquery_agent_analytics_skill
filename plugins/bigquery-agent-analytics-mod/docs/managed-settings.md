# Turn the mod on for a team with managed settings

For the administrator who deploys the host CLI's managed settings. With one
policy file, every person's sessions write to one BigQuery table: nobody
installs or configures the mod, and nobody can point it somewhere else.

Managed settings sit above every other settings level. For the mod that
means, key by key:

- an option the policy sets wins over the person's own option, a
  `--settings` file, and the environment;
- an option the policy leaves out takes the person's value as usual;
- a variable the policy's `env` sets wins over the person's settings, a
  repository's `.claude/settings.json` and the shell.

## Before you start

1. **The table.** Run [`setup.sh`](../setup.sh) once. It makes the dataset,
   the events table and the usage views.
2. **The writer.** Pick how sessions get a token. The
   [service-account guide](service-account-auth.md) covers a writer service
   account that people impersonate (no key, no table access for anyone);
   `setup.sh --service-account` sets it up. Each person signs in to gcloud
   once.
3. **Where the mod comes from.** Either:
   - [a folder you deploy to every machine](#1-the-marketplace-folder) (recommended
     where you can deploy files). The mod then counts as your
     organization's: it runs ahead of people's own mods, a person cannot turn
     it off, and it keeps working when you allow only your organization's
     mods; or
   - [the GitHub marketplace](#5-without-a-folder-the-github-marketplace)
     (no files to deploy). The mod then runs like one a person installed.

## 1. The marketplace folder

Put this on every machine, at the same absolute path, owned by an
administrator and writable by nobody else (the folder and every folder above
it):

```text
/opt/org/agent-plugins/
├── .claude-plugin/marketplace.json
└── plugins/bigquery-agent-analytics-mod/   (the mod, for example a git archive of a release)
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

To copy the mod from this repository: `git archive <release> plugins/bigquery-agent-analytics-mod | tar -x --strip-components=1 -C /opt/org/agent-plugins/plugins`.

## 2. The policy

The host CLI reads its managed settings from one file per machine (or from
your device management, or the host's admin console):

- Linux and WSL: `/etc/claude-code/managed-settings.json`
- macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
- Windows: `C:\Program Files\ClaudeCode\managed-settings.json`

A `managed-settings.d/` folder beside the file takes drop-in files that
merge with it, so the mod's part can live in a file of its own.

```json
{
  "extraKnownMarketplaces": {
    "org-tools": { "source": { "source": "directory", "path": "/opt/org/agent-plugins" } }
  },
  "enabledPlugins": { "bigquery-agent-analytics-mod@org-tools": true },
  "pluginConfigs": {
    "bigquery-agent-analytics-mod@org-tools": {
      "options": {
        "project": "my-gcp-project",
        "dataset": "agent_analytics",
        "location": "US",
        "enabled": true,
        "dryRun": false,
        "accessTokenCommand": "/usr/bin/gcloud auth print-access-token --impersonate-service-account=bqaa-writer@my-gcp-project.iam.gserviceaccount.com",
        "userIdFromCredentials": false,
        "recordHostname": false
      }
    }
  },
  "env": {
    "BQAA_TRACE_ENABLED": "true",
    "BQAA_DRY_RUN": "false",
    "BQAA_ACCESS_TOKEN": "",
    "BQAA_AUTO_CREATE_TABLE": "false"
  }
}
```

| Entry | What it does |
| --- | --- |
| `extraKnownMarketplaces` | Names the folder that holds the marketplace |
| `enabledPlugins` | Turns the mod on for everyone who gets the policy |
| `options.project`, `dataset`, `location` | The destination. A person's own options, and `BQAA_PROJECT_ID` / `BQAA_DATASET` in their environment, change nothing |
| `options.accessTokenCommand` | How tokens are had: here, impersonation of the writer service account. Name gcloud by its absolute path on your machines: a session started from a desktop app or an editor may not have the shell's `PATH` |
| `options.userIdFromCredentials: false` | `user_id` is each person's login name. Under impersonation, turning it on would make every row's `user_id` the service account |
| `options.recordHostname: false` | No machine names in the rows (personal data, off by default) |
| `options.enabled`, `options.dryRun` and `env` `BQAA_TRACE_ENABLED`, `BQAA_DRY_RUN` | Capture on, and rows really sent. These two switches also read their environment variables: without the `env` pins, a person's `BQAA_TRACE_ENABLED=false` (in the shell, or a repository's settings) still turns capture off |
| `env` `BQAA_ACCESS_TOKEN: ""` | No token from a person's environment in place of the command |
| `env` `BQAA_AUTO_CREATE_TABLE: "false"` | People's credentials never create the table; `setup.sh` made it |

The person's sessions pick the policy up when they start. On a machine,
`claude -p /bqaa-status` (no model call) prints
`enabled, target my-gcp-project.agent_analytics.agent_events (US)`, and
`claude -p --debug-file /tmp/bqaa.log /bqaa-status` leaves the line
`hooks module bigquery-agent-analytics-mod@org-tools loaded (... tier prepend)`
in the log: the mod runs as your organization's.

## 3. What people can still change

- **Keys the policy leaves out.** Every option the policy does not set
  still takes the person's value. Set every one you care about.
- **Turning the mod off.** With the folder, a person's own
  `"enabledPlugins": { ...: false }` does not turn it off. To let people opt
  out, leave `enabled` and `BQAA_TRACE_ENABLED` out of the policy; they can
  then set `enabled` to false (`/plugin configure`) or export
  `BQAA_TRACE_ENABLED=false`.
- **Where their unsent rows wait.** `deadLetterDir` stays each person's own
  (a folder in their home by default); a pinned `~/...` path would not be
  expanded.
- **Running without plugins at all.** The host's safe and bare modes
  (`--safe-mode`, `--bare`, `CLAUDE_CODE_SAFE_MODE=1`) skip installed
  plugins, your organization's included. Managed settings also bind only
  the host CLI: people who use other tools are not traced. Someone with
  administrator rights on their machine can edit the policy file.
- **What a row says.** `user_id` and every other column are what the
  person's machine sends. BigQuery checks who may insert, not what a row
  holds, so treat `user_id` as an attribution, not proof.

To also keep people's own mods and plugin folders out (fleet-wide, every
plugin, not just this one), the host's managed settings take
`allowManagedModsOnly` (an option of the built-in `cc-plugin-sec-default`
plugin, under `pluginConfigs`), `disableSideloadFlags` and
`strictKnownMarketplaces`. None is needed to send everyone's rows to one
table.

## 4. Roll it out in stages

1. **Pilot.** Deliver the policy to a few machines (an MDM scope, or the
   file by hand). On each: `claude -p /bqaa-status` shows `enabled` and the
   target; after a session, the person's rows are in the table and in
   `<dataset>_reporting.daily_usage_by_user` with today's date.
2. **Watch.** `/bqaa-status` on a pilot machine names any notice: no
   working credentials (the token command; the service-account grants), no
   access to the table, or a missing table. Rows wait on the person's disk
   until it is fixed, and are sent then.
3. **Widen** the scope in steps. A policy change reaches each person at
   their next session.

## 5. Without a folder: the GitHub marketplace

Where you can deliver settings but not files (some device management, the
host's admin console), name the GitHub marketplace instead:

```json
{
  "extraKnownMarketplaces": {
    "bigquery-agent-analytics-plugin": {
      "source": { "source": "github", "repo": "haiyuan-eng-google/bigquery_agent_analytics_skill" }
    }
  },
  "enabledPlugins": { "bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin": true },
  "pluginConfigs": {
    "bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin": { "options": { "project": "...", "dataset": "...", "accessTokenCommand": "..." } }
  },
  "env": { "BQAA_TRACE_ENABLED": "true", "BQAA_DRY_RUN": "false", "BQAA_ACCESS_TOKEN": "", "BQAA_AUTO_CREATE_TABLE": "false" }
}
```

The options and `env` pins hold the same way (the key is now
`bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin`). The
differences:

- The mod is copied into each person's plugin cache, so it runs like a mod
  the person installed: after your organization's, and refused when you
  allow only your organization's mods. The host's debug log says so: "is
  enabled by managed settings, but it is not read in place from a local
  folder".
- On a fresh machine it starts recording at the third session: the first
  registers the marketplace and the second installs the mod in the
  background. To record from the first session, have each person (or a
  setup script run as the person) install it once:
  `claude plugin install bigquery-agent-analytics-mod --marketplace haiyuan-eng-google/bigquery_agent_analytics_skill`
  (no `--config`: the policy's options apply).
- It follows the repository, so pin it to a release where your device
  management allows, and plan for a person being able to update or remove
  their copy.

## 6. Data handling

The table receives each person's prompts, the model's visible answers, tool
arguments and tool results, cut to `maxPayloadChars` per column (the
README's [Privacy and security](../README.md#privacy-and-security) has the
redaction rules: an allowlist of keys at any depth, credential-shaped
values removed). Before a rollout, take these to whoever reviews data
handling:

- **What is collected:** the above, plus token counts, latency, tool names
  and outcomes. `user_id` is the login name (or, with
  `userIdFromCredentials`, the token's verified email); host names only with
  `recordHostname`. Both identity options are off by default.
- **Who can read it:** writers cannot read rows (the `bqaaRowWriter` role
  inserts only). Readers of the views see counts and tokens, not prompts.
  Give raw table access to an administrator group only.
- **How long it stays:** set a partition expiration on the table
  (`ALTER TABLE ... SET OPTIONS (partition_expiration_days = N)`); the mod
  sets none.
- **Where it goes:** only the project and dataset in the policy, over
  HTTPS to BigQuery. Rows that could not be sent wait in a folder in each
  person's home until they are.

## Checked

`tests/managed-settings.live.sh` runs the folder setup above in a Linux
container: a root-owned policy, an administrator-owned marketplace folder,
and an ordinary user whose own settings, repository settings and shell all
say otherwise (another dataset, capture off, dry run, a token of their own,
the mod disabled). It checks that the mod loads as the organization's, at
the policy's destination, with capture on, live writes and the policy's
token command, and that without the `env` pins the shell's
`BQAA_TRACE_ENABLED=false` does turn capture off. It needs docker and the
host CLI's Linux build:

```bash
HOST_CLI_LINUX=/path/to/linux/claude bash tests/managed-settings.live.sh
```
