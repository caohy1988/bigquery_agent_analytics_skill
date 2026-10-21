#!/usr/bin/env python3
"""Bootstrap Google Cloud prerequisites for BQAA tracing.

The script is intentionally dry-run by default. Pass --execute when the printed
plan looks right. It uses the caller's current Google Cloud credentials for
setup, and grants narrower runtime roles to --principal when provided.

--writer-role row-writer grants the writer only what inserting rows takes: a
custom role with bigquery.tables.updateData and bigquery.tables.get, on the
events table alone, so the writer reads no rows, runs no queries and deletes
nothing. --token-creator lets a group impersonate the writer service account,
and --reader gives a group the views (in the views dataset), with the views
authorized on the events dataset so readers need no access to the table.
Before it grants anything, it refuses a writer that already holds other
grants on the project, the datasets or the table (--allow-existing-grants
keeps them), and a bqaaRowWriter role that holds more than those two
permissions.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SDK_PATH = PLUGIN_ROOT / "sdk" / "python"
sys.path.insert(0, str(SDK_PATH))

from bqaa_tracing import bq_schema  # noqa: E402


BIGQUERY_API_SERVICES = ("bigquery.googleapis.com", "bigquerystorage.googleapis.com")
# The custom role --writer-role row-writer grants: streaming inserts check
# bigquery.tables.get as well as bigquery.tables.updateData ("Permission
# bigquery.tables.get denied on table" without it).
ROW_WRITER_ROLE_ID = "bqaaRowWriter"
ROW_WRITER_PERMISSIONS = ("bigquery.tables.get", "bigquery.tables.updateData")

PRINCIPAL_PREFIXES = (
    "user:",
    "serviceAccount:",
    "group:",
    "domain:",
    "principal://",
    "principalSet://",
)


@dataclass(frozen=True)
class Step:
    """One unit of bootstrap work.

    Each step declares which credential surfaces it actually needs so
    the preflight gate can fail-fast on the right one. ``Step.action``
    callbacks aren't all ADC-backed — ``_ensure_service_account`` is
    an action but it shells out to ``gcloud iam service-accounts``,
    which uses the gcloud CLI account, not ADC. Inferring needs from
    ``command`` vs ``action`` was wrong; explicit flags are the fix.
    """

    label: str
    command: list[str] | None = None
    action: Callable[[], None] | None = None
    detail: str | None = None
    needs_adc: bool = False
    needs_cli_auth: bool = False


@dataclass(frozen=True)
class _PreflightResult:
    """Captured state of the caller's gcloud auth + config.

    Two distinct credential surfaces matter and they fail independently:

    * **ADC** — used by every google-cloud-* Python client (so
      ``bigquery.Client.create_dataset``, ``create_table``, etc.)
      Validated with ``gcloud auth application-default print-access-token``.
    * **gcloud CLI auth** — used by every ``gcloud`` and ``bq`` subprocess
      this script spawns (``services enable``, ``projects
      add-iam-policy-binding``, ``iam service-accounts create``,
      ``bq add-iam-policy-binding``). Validated with ``gcloud auth list``
      and ``gcloud auth print-access-token``.

    They share an identity in most local-dev setups (one ``gcloud auth
    login`` plus one ``application-default login``), but on agent boxes
    or CI they're often separate, so check both. Reporting them
    separately also makes the failure message actionable.
    """

    adc_ok: bool
    adc_message: str
    cli_auth_ok: bool
    cli_auth_account: str
    cli_auth_message: str
    gcloud_project: str
    gcloud_available: bool


def _gcloud_command(args: argparse.Namespace, *parts: str) -> list[str]:
    """Build a gcloud invocation; in --non-interactive mode injects --quiet.

    gcloud's --quiet is a global flag that auto-confirms prompts and
    suppresses interactive checks. Required when an agent runs the
    bootstrap unattended so a confirmation prompt can never block.
    """
    cmd = ["gcloud"]
    if args.non_interactive:
        cmd.append("--quiet")
    cmd.extend(parts)
    return cmd


def _bq_command(args: argparse.Namespace, *parts: str) -> list[str]:
    """Build a bq invocation; in --non-interactive mode injects --quiet.

    bq's --quiet is a global flag that suppresses status messages and
    interactive confirms. Same purpose as gcloud's --quiet.
    """
    cmd = ["bq"]
    if args.non_interactive:
        cmd.append("--quiet")
    cmd.extend(parts)
    return cmd


def _default_project() -> str:
    return (
        os.environ.get("BQAA_PROJECT_ID")
        or os.environ.get("GCP_PROJECT_ID")
        or os.environ.get("GOOGLE_CLOUD_PROJECT")
        or ""
    )


def _default_dataset() -> str:
    return os.environ.get("BQAA_DATASET") or os.environ.get("BQ_DATASET") or "agent_analytics"


def _default_table() -> str:
    return os.environ.get("BQAA_TABLE") or os.environ.get("BQ_TABLE") or "agent_events"


def _quote_command(command: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in command)


def _service_account_email(project: str, value: str) -> str:
    if "@" in value:
        return value
    return f"{value}@{project}.iam.gserviceaccount.com"


def _service_account_id(value: str) -> str:
    return value.split("@", 1)[0]


def _ensure_service_account(args: argparse.Namespace) -> None:
    project = args.project
    value = args.service_account
    email = _service_account_email(project, value)
    describe = subprocess.run(
        _gcloud_command(
            args,
            "iam",
            "service-accounts",
            "describe",
            email,
            "--project",
            project,
        ),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if describe.returncode == 0:
        print(f"OK service account exists: {email}")
        return
    command = _gcloud_command(
        args,
        "iam",
        "service-accounts",
        "create",
        _service_account_id(value),
        "--project",
        project,
        "--display-name",
        "BQAA tracing writer",
    )
    last_result: subprocess.CompletedProcess[str] | None = None
    for attempt in range(1, 4):
        last_result = subprocess.run(command, check=False)
        if last_result.returncode == 0:
            print(f"CREATED service account: {email}")
            return
        if attempt < 3:
            print(
                "Service account create failed; retrying after API/IAM propagation "
                f"delay (attempt {attempt}/3).",
                file=sys.stderr,
            )
            time.sleep(5)
    returncode = last_result.returncode if last_result else 1
    raise subprocess.CalledProcessError(returncode, command)


def _validate_principal(value: str) -> None:
    if value in ("allUsers", "allAuthenticatedUsers"):
        return
    if any(value.startswith(prefix) for prefix in PRINCIPAL_PREFIXES):
        return
    raise SystemExit(
        "--principal must start with one of: "
        "user:, serviceAccount:, group:, domain:, principal://, principalSet:// "
        "(or be allUsers/allAuthenticatedUsers)"
    )


def _require_project_dataset(args: argparse.Namespace) -> None:
    if not args.project:
        raise SystemExit(
            "--project is required, or set BQAA_PROJECT_ID/GCP_PROJECT_ID/GOOGLE_CLOUD_PROJECT"
        )
    if not args.dataset:
        raise SystemExit("--dataset is required, or set BQAA_DATASET")
    if args.principal:
        _validate_principal(args.principal)
    if args.token_creator and not args.service_account:
        raise SystemExit("--token-creator goes with --service-account")
    for member in [*args.token_creator, *args.reader]:
        if not any(member.startswith(prefix) for prefix in ("user:", "group:", "serviceAccount:", "domain:")):
            raise SystemExit(
                f"{member!r}: --token-creator and --reader take user:, group:, "
                "serviceAccount: or domain: members"
            )


def _dataset_grant_command(args: argparse.Namespace, dataset: str, member: str, role: str) -> list[str]:
    """Grant a role on a dataset with BigQuery's GRANT statement.

    ``bq add-iam-policy-binding`` takes a dataset only on allowlisted
    projects ("This feature requires allowlisting"), and stops reading flags
    at its first positional argument, so the SQL statement is the reliable
    way. Members are checked before this (a principal prefix and no quotes).
    """
    if '"' in member or "`" in member or "`" in role:
        raise SystemExit(f"{member!r} or {role!r} holds a quote")
    statement = f'GRANT `{role}` ON SCHEMA `{args.project}.{dataset}` TO "{member}"'
    return _bq_command(
        args,
        f"--project_id={args.project}",
        "query",
        "--use_legacy_sql=false",
        f"--location={args.location or 'US'}",
        statement,
    )


def _views_dataset(args: argparse.Namespace) -> str:
    return args.views_dataset or f"{args.dataset}_reporting"


def _json_output(command: list[str], missing_ok: bool = False) -> dict:
    """Run a gcloud or bq command that prints JSON, and parse it.

    With ``missing_ok``, a resource that does not exist reads as ``{}``.
    """
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        said = f"{result.stderr or ''}\n{result.stdout or ''}"
        if missing_ok and ("Not found" in said or "NOT_FOUND" in said):
            return {}
        raise SystemExit(f"{_quote_command(command)} failed: {_summarize_stderr(said, 'no output')}")
    try:
        value = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as error:
        raise SystemExit(f"{_quote_command(command)} printed no JSON: {error}") from error
    return value if isinstance(value, dict) else {}


def _ensure_row_writer_role(args: argparse.Namespace) -> None:
    """Create the row-writer role, or add the permissions it lacks.

    A role that holds more than ROW_WRITER_PERMISSIONS is refused: bound on
    the table, it would let the writer read or change it.
    """
    project = args.project
    name = f"projects/{project}/roles/{ROW_WRITER_ROLE_ID}"
    describe = subprocess.run(
        _gcloud_command(args, "iam", "roles", "describe", ROW_WRITER_ROLE_ID, "--project", project, "--format=json"),
        capture_output=True,
        text=True,
        check=False,
    )
    if describe.returncode == 0:
        try:
            role = json.loads(describe.stdout or "{}")
        except json.JSONDecodeError as error:
            raise SystemExit(f"gcloud iam roles describe {name} printed no JSON: {error}") from error
        if role.get("deleted"):
            raise SystemExit(
                f"{name} is deleted. Undelete it (gcloud iam roles undelete {ROW_WRITER_ROLE_ID} "
                f"--project {project}) and run again."
            )
        held = set(role.get("includedPermissions") or [])
        extra = sorted(held - set(ROW_WRITER_PERMISSIONS))
        if extra:
            raise SystemExit(
                f"{name} also holds {', '.join(extra)}: bound on the table, it would let the writer "
                f"do more than insert rows. Remove them (gcloud iam roles update {ROW_WRITER_ROLE_ID} "
                f"--project {project} --remove-permissions {','.join(extra)}) and run again."
            )
        missing = [permission for permission in ROW_WRITER_PERMISSIONS if permission not in held]
        if missing:
            subprocess.run(
                _gcloud_command(
                    args, "iam", "roles", "update", ROW_WRITER_ROLE_ID, "--project", project,
                    "--add-permissions", ",".join(missing), "--quiet",
                ),
                stdout=subprocess.DEVNULL,
                check=True,
            )
            print(f"UPDATED role {name}: added {', '.join(missing)}")
        else:
            print(f"OK role exists, with {', '.join(ROW_WRITER_PERMISSIONS)} only: {name}")
        return
    permissions = ",".join(ROW_WRITER_PERMISSIONS)
    subprocess.run(
        _gcloud_command(
            args, "iam", "roles", "create", ROW_WRITER_ROLE_ID, "--project", project,
            "--title", "BQAA row writer",
            "--description", "Inserts rows into the tables it is granted on, and reads none",
            "--permissions", permissions, "--stage", "GA",
        ),
        stdout=subprocess.DEVNULL,
        check=True,
    )
    print(f"CREATED role: {name} ({permissions})")


# The access-entry key that names a member of each kind in a dataset's ACL.
_ACCESS_KEYS = {"user": "userByEmail", "serviceAccount": "userByEmail", "group": "groupByEmail", "domain": "domain"}


def _check_writer_grants(args: argparse.Namespace) -> None:
    """Refuse a writer that already holds more than the row-writer role.

    Looks at the project's IAM policy, the events and views datasets' access
    and the events table's IAM policy. A reused service account (one an
    earlier setup gave dataEditor and jobUser, say) would otherwise hand
    every token creator a read of every row.
    """
    principal = args.principal
    kind, _, name = principal.partition(":")
    lowered = principal.lower()
    role = f"projects/{args.project}/roles/{ROW_WRITER_ROLE_ID}"
    found: list[str] = []
    policy = _json_output(_gcloud_command(args, "projects", "get-iam-policy", args.project, "--format=json"))
    for binding in policy.get("bindings") or []:
        if lowered in (member.lower() for member in binding.get("members") or []):
            found.append(f"{binding.get('role')} on the project {args.project}")
    key = _ACCESS_KEYS.get(kind)
    for dataset in dict.fromkeys([args.dataset, _views_dataset(args)]):
        info = _json_output(_bq_command(args, "--format=json", "show", f"{args.project}:{dataset}"), missing_ok=True)
        for entry in info.get("access") or []:
            named = (key is not None and str(entry.get(key, "")).lower() == name.lower()) or str(
                entry.get("iamMember", "")
            ).lower() == lowered
            if named:
                found.append(f"{entry.get('role')} on the dataset {args.project}.{dataset}")
    table = f"{args.project}:{args.dataset}.{args.table}"
    table_policy = _json_output(_bq_command(args, "--format=json", "get-iam-policy", table), missing_ok=True)
    for binding in table_policy.get("bindings") or []:
        if binding.get("role") == role:
            continue
        if lowered in (member.lower() for member in binding.get("members") or []):
            found.append(f"{binding.get('role')} on the table {args.project}.{args.dataset}.{args.table}")
    if not found:
        print(f"OK {principal} holds nothing on the project, the datasets or the table beyond {role}")
        return
    listed = "\n  - ".join(found)
    if args.allow_existing_grants:
        print(f"KEPT (--allow-existing-grants) what {principal} already holds:\n  - {listed}")
        return
    raise SystemExit(
        f"{principal} already holds more than the row-writer role:\n  - {listed}\n"
        "Its tokens could read or change the table. Use a new service account for the writer, or "
        "remove those grants and run again; --allow-existing-grants keeps them (an audited account)."
    )


def _check_api_enabled(args: argparse.Namespace, service: str) -> None:
    """Fail when a service the plan relies on is not enabled (--no-enable-apis)."""
    result = subprocess.run(
        _gcloud_command(
            args, "services", "list", "--enabled", "--project", args.project,
            f"--filter=config.name={service}", "--format=value(config.name)",
        ),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or service not in (result.stdout or "").split():
        raise SystemExit(
            f"{service} is not enabled on {args.project}: impersonation needs it. Enable it "
            f"(gcloud services enable {service} --project {args.project}), or run without --no-enable-apis."
        )
    print(f"OK {service} is enabled")


def _run_with_retry(command: list[str], what: str) -> None:
    """A binding, tried again for a minute: a service account made moments ago
    is not yet a member IAM accepts everywhere."""
    for attempt in range(1, 8):
        result = subprocess.run(command, stdout=subprocess.DEVNULL, check=False)
        if result.returncode == 0:
            return
        if attempt < 7:
            print(f"{what} failed; retrying after IAM propagation delay (attempt {attempt}/7).", file=sys.stderr)
            time.sleep(10)
    raise subprocess.CalledProcessError(result.returncode, command)


def _authorize_views(project: str, dataset: str, views_dataset: str) -> None:
    """Authorize every view of the views dataset on the events dataset, so
    readers of the views need no access to the table."""
    from google.cloud import bigquery

    client = bigquery.Client(project=project)
    source = client.get_dataset(f"{project}.{dataset}")
    views = [t for t in client.list_tables(f"{project}.{views_dataset}") if t.table_type == "VIEW"]
    if not views:
        print(f"SKIPPED: no views in {project}.{views_dataset} yet (the mod's setup.sh makes them)")
        return
    entries = list(source.access_entries)
    known = {
        (e.entity_id.get("projectId"), e.entity_id.get("datasetId"), e.entity_id.get("tableId"))
        for e in entries
        if e.entity_type == "view" and isinstance(e.entity_id, dict)
    }
    added = []
    for view in views:
        key = (view.project, view.dataset_id, view.table_id)
        if key in known:
            continue
        entries.append(
            bigquery.AccessEntry(
                None, "view", {"projectId": view.project, "datasetId": view.dataset_id, "tableId": view.table_id}
            )
        )
        added.append(view.table_id)
    if added:
        source.access_entries = entries
        client.update_dataset(source, ["access_entries"])
        print(f"AUTHORIZED on {project}.{dataset}: {', '.join(added)}")
    else:
        print(f"OK views already authorized on {project}.{dataset}")


def _ensure_dataset(project: str, dataset: str, location: str | None) -> None:
    from google.cloud import bigquery
    from google.cloud.exceptions import NotFound

    client = bigquery.Client(project=project, location=location)
    dataset_id = f"{project}.{dataset}"
    try:
        client.get_dataset(dataset_id)
        print(f"OK dataset exists: {dataset_id}")
        return
    except NotFound:
        pass

    bq_dataset = bigquery.Dataset(dataset_id)
    if location:
        bq_dataset.location = location
    client.create_dataset(bq_dataset)
    print(f"CREATED dataset: {dataset_id}")


def _ensure_table(
    project: str, dataset: str, table: str, location: str | None
) -> None:
    from google.cloud import bigquery
    from google.cloud.exceptions import NotFound

    client = bigquery.Client(project=project, location=location)
    table_id = f"{project}.{dataset}.{table}"
    try:
        client.get_table(table_id)
        print(f"OK table exists: {table_id}")
        return
    except NotFound:
        pass

    bq_table = bigquery.Table(table_id, schema=bq_schema(bigquery))
    bq_table.time_partitioning = bigquery.TimePartitioning(
        type_=bigquery.TimePartitioningType.DAY,
        field="timestamp",
    )
    bq_table.clustering_fields = ["event_type", "agent", "user_id"]
    bq_table.labels = {"adk_schema_version": "1"}
    client.create_table(bq_table)
    print(f"CREATED table: {table_id}")


def _build_steps(args: argparse.Namespace) -> list[Step]:
    steps: list[Step] = []
    if args.enable_apis:
        services = list(BIGQUERY_API_SERVICES)
        if args.service_account:
            services.append("iam.googleapis.com")
        if args.token_creator:
            # Impersonation's tokens come from the IAM Service Account
            # Credentials API.
            services.append("iamcredentials.googleapis.com")
        steps.append(
            Step(
                "Enable Google Cloud APIs",
                _gcloud_command(
                    args,
                    "services",
                    "enable",
                    *services,
                    "--project",
                    args.project,
                ),
                needs_cli_auth=True,
            )
        )

    if args.service_account:
        steps.append(
            Step(
                f"Ensure service account {_service_account_email(args.project, args.service_account)}",
                action=lambda: _ensure_service_account(args),
                detail=(
                    "gcloud iam service-accounts describe; on missing, "
                    "create service account with a short retry for API/IAM propagation"
                ),
                # Reviewer Finding #2: this action shells out to gcloud,
                # so it depends on CLI auth, not ADC.
                needs_cli_auth=True,
            )
        )

    if args.create_dataset:
        steps.append(
            Step(
                f"Ensure dataset {args.project}.{args.dataset}",
                action=lambda: _ensure_dataset(args.project, args.dataset, args.location),
                detail=(
                    "bigquery.Client.get_dataset(); on NotFound, "
                    f"create_dataset(location={args.location or 'client default'})"
                ),
                needs_adc=True,
            )
        )

    if args.create_table:
        steps.append(
            Step(
                f"Ensure table {args.project}.{args.dataset}.{args.table}",
                action=lambda: _ensure_table(
                    args.project, args.dataset, args.table, args.location
                ),
                detail=(
                    "bigquery.Client.get_table(); on NotFound, create partitioned "
                    "agent_events table using bqaa_tracing.bq_schema()"
                ),
                needs_adc=True,
            )
        )

    if args.grant_iam and args.principal and args.writer_role == "row-writer":
        role = f"projects/{args.project}/roles/{ROW_WRITER_ROLE_ID}"
        steps.extend(
            [
                Step(
                    f"Check that {args.principal} holds nothing beyond the row-writer role",
                    action=lambda: _check_writer_grants(args),
                    detail=(
                        "gcloud projects get-iam-policy; bq show of the events and views "
                        "datasets; bq get-iam-policy of the table. Stops on any other grant "
                        "unless --allow-existing-grants"
                    ),
                    needs_cli_auth=True,
                ),
                Step(
                    f"Ensure role {role} ({', '.join(ROW_WRITER_PERMISSIONS)})",
                    action=lambda: _ensure_row_writer_role(args),
                    detail=(
                        "gcloud iam roles describe; on missing, create with "
                        f"{','.join(ROW_WRITER_PERMISSIONS)}; else add any it lacks, "
                        "and stop if it holds any other"
                    ),
                    needs_cli_auth=True,
                ),
                Step(
                    "Grant the row-writer role to runtime principal, on the table alone",
                    _bq_command(
                        args,
                        "add-iam-policy-binding",
                        "--member",
                        args.principal,
                        "--role",
                        role,
                        f"{args.project}:{args.dataset}.{args.table}",
                    ),
                    needs_cli_auth=True,
                ),
            ]
        )
    elif args.grant_iam and args.principal:
        steps.extend(
            [
                Step(
                    "Grant dataset dataEditor to runtime principal",
                    _dataset_grant_command(args, args.dataset, args.principal, "roles/bigquery.dataEditor"),
                    needs_cli_auth=True,
                ),
                Step(
                    "Grant project jobUser for verification queries",
                    _gcloud_command(
                        args,
                        "projects",
                        "add-iam-policy-binding",
                        args.project,
                        "--member",
                        args.principal,
                        "--role",
                        "roles/bigquery.jobUser",
                    ),
                    needs_cli_auth=True,
                ),
            ]
        )
        if args.runtime_auto_create_dataset:
            steps.append(
                Step(
                    "Grant project bigquery.user for runtime dataset creation",
                    _gcloud_command(
                        args,
                        "projects",
                        "add-iam-policy-binding",
                        args.project,
                        "--member",
                        args.principal,
                        "--role",
                        "roles/bigquery.user",
                    ),
                    needs_cli_auth=True,
                )
            )
    if args.service_account:
        email = _service_account_email(args.project, args.service_account)
        if args.token_creator and not args.enable_apis:
            steps.append(
                Step(
                    "Check that iamcredentials.googleapis.com is enabled",
                    action=lambda: _check_api_enabled(args, "iamcredentials.googleapis.com"),
                    detail="gcloud services list --enabled; impersonation's tokens come from this API",
                    needs_cli_auth=True,
                )
            )
        for member in args.token_creator:
            command = _gcloud_command(
                args, "iam", "service-accounts", "add-iam-policy-binding", email,
                "--project", args.project, "--member", member,
                "--role", "roles/iam.serviceAccountTokenCreator",
            )
            steps.append(
                Step(
                    f"Grant token creation on {email} to {member}",
                    action=lambda command=command, member=member: _run_with_retry(command, f"Token Creator for {member}"),
                    detail=_quote_command(command),
                    needs_cli_auth=True,
                )
            )

    views_dataset = _views_dataset(args)
    for member in args.reader:
        steps.extend(
            [
                Step(
                    f"Grant views dataset dataViewer to reader {member}",
                    _dataset_grant_command(args, views_dataset, member, "roles/bigquery.dataViewer"),
                    needs_cli_auth=True,
                ),
                Step(
                    f"Grant project jobUser to reader {member}, to run queries",
                    _gcloud_command(
                        args, "projects", "add-iam-policy-binding", args.project,
                        "--member", member, "--role", "roles/bigquery.jobUser",
                    ),
                    needs_cli_auth=True,
                ),
            ]
        )
    if args.reader:
        steps.append(
            Step(
                f"Authorize the views of {args.project}.{views_dataset} on {args.project}.{args.dataset}",
                action=lambda: _authorize_views(args.project, args.dataset, views_dataset),
                detail=(
                    "bigquery.Client: add each view of the views dataset to the events "
                    "dataset's access entries, so readers need no access to the table"
                ),
                needs_adc=True,
            )
        )
    return steps


def _summarize_stderr(stderr: str, fallback: str) -> str:
    """Compact a multi-line gcloud error to a one-line preflight summary.

    Joins the last few non-empty stderr lines with `` | `` so the
    actionable parts (`ERROR:`, `Reauthentication required`,
    `to select an already authenticated account run: gcloud config set
    account ACCOUNT`) all survive into the one-screen preflight output.
    Earlier code took only the last line, which on real gcloud failures
    discarded the part of the message that named the fix.
    """
    lines = [line.strip() for line in (stderr or "").splitlines() if line.strip()]
    if not lines:
        return fallback
    return " | ".join(lines[-3:])


def _run_preflight() -> _PreflightResult:
    """Capture gcloud auth + config state without raising.

    Tests both credential surfaces:

    * ADC, via ``gcloud auth application-default print-access-token``.
      What the google-cloud-bigquery Python client uses.
    * gcloud CLI auth, via ``gcloud auth list`` (active account name)
      and ``gcloud auth print-access-token`` (token actually works).
      What every ``gcloud`` and ``bq`` subprocess this script spawns
      uses.

    Each subprocess call is bounded by a short timeout so a stuck
    gcloud install can't hang the bootstrap.
    """

    def _empty_result(reason: str, gcloud_available: bool) -> _PreflightResult:
        return _PreflightResult(
            adc_ok=False,
            adc_message=reason,
            cli_auth_ok=False,
            cli_auth_account="",
            cli_auth_message=reason,
            gcloud_project="",
            gcloud_available=gcloud_available,
        )

    try:
        adc = subprocess.run(
            ["gcloud", "auth", "application-default", "print-access-token"],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
    except FileNotFoundError:
        return _empty_result("gcloud not on PATH", False)
    except subprocess.TimeoutExpired:
        return _empty_result("gcloud timed out", True)
    adc_ok = adc.returncode == 0
    if adc_ok:
        adc_message = "ADC token reachable"
    else:
        adc_message = "not configured — " + _summarize_stderr(
            adc.stderr, fallback="no token"
        )

    cli_auth_account = ""
    cli_auth_ok = False
    cli_auth_message = "not configured"
    try:
        listed = subprocess.run(
            [
                "gcloud",
                "auth",
                "list",
                "--filter=status:ACTIVE",
                "--format=value(account)",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
        cli_auth_account = listed.stdout.strip().splitlines()[0] if listed.stdout.strip() else ""
    except (FileNotFoundError, subprocess.TimeoutExpired):
        cli_auth_account = ""
    if cli_auth_account:
        # An active account is listed. Confirm the token actually works —
        # ``gcloud auth list`` happily reports an account whose token is
        # expired or whose grant has been revoked, so the list-only check
        # alone is too optimistic. ``print-access-token`` is the cheap
        # ground-truth probe.
        try:
            tok = subprocess.run(
                ["gcloud", "auth", "print-access-token"],
                capture_output=True,
                text=True,
                check=False,
                timeout=15,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            tok = None
            cli_auth_message = f"token probe failed: {exc}"
        else:
            if tok.returncode == 0:
                cli_auth_ok = True
                cli_auth_message = f"active account {cli_auth_account}"
            else:
                cli_auth_message = (
                    f"active account {cli_auth_account} but token probe failed — "
                    + _summarize_stderr(tok.stderr, fallback="no token")
                )
    else:
        cli_auth_message = (
            "no active account — run `gcloud auth login` "
            "or `gcloud config set account ACCOUNT`"
        )

    try:
        proj = subprocess.run(
            ["gcloud", "config", "get-value", "project"],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
        gcloud_project = proj.stdout.strip() if proj.returncode == 0 else ""
    except (FileNotFoundError, subprocess.TimeoutExpired):
        gcloud_project = ""
    if gcloud_project == "(unset)":
        gcloud_project = ""
    return _PreflightResult(
        adc_ok=adc_ok,
        adc_message=adc_message,
        cli_auth_ok=cli_auth_ok,
        cli_auth_account=cli_auth_account,
        cli_auth_message=cli_auth_message,
        gcloud_project=gcloud_project,
        gcloud_available=True,
    )


def _print_preflight(result: _PreflightResult, args: argparse.Namespace) -> None:
    print("Preflight:")
    if not result.gcloud_available:
        print(f"  gcloud: NOT AVAILABLE — {result.adc_message}")
        print()
        return
    adc_label = "OK" if result.adc_ok else "NOT CONFIGURED"
    print(f"  ADC: {adc_label} — {result.adc_message}")
    cli_label = "OK" if result.cli_auth_ok else "NOT CONFIGURED"
    print(f"  gcloud CLI auth: {cli_label} — {result.cli_auth_message}")
    if result.gcloud_project:
        if result.gcloud_project == args.project:
            note = "matches --project"
        else:
            note = (
                f"differs from --project ({args.project}); "
                "subcommands pass --project explicitly so this is OK, "
                "but cross-check before --execute"
            )
        print(f"  gcloud config project: {result.gcloud_project} ({note})")
    else:
        print("  gcloud config project: (unset)")
    print()


def _steps_need_adc(steps: list[Step]) -> bool:
    """Whether any step in the plan needs Application Default Credentials."""
    return any(step.needs_adc for step in steps)


def _steps_need_cli_auth(steps: list[Step]) -> bool:
    """Whether any step in the plan needs the gcloud CLI account."""
    return any(step.needs_cli_auth for step in steps)


def _print_plan(args: argparse.Namespace, steps: list[Step]) -> None:
    mode = "EXECUTE" if args.execute else "DRY RUN"
    print(f"BQAA GCP prerequisite bootstrap ({mode})")
    print(f"project:  {args.project}")
    print(f"dataset:  {args.dataset}")
    print(f"table:    {args.table}")
    print(f"location: {args.location or '(client default)'}")
    principal = args.principal or "(IAM grants skipped)"
    print(f"principal: {principal}")
    if args.principal and args.grant_iam:
        print(f"writer role: {args.writer_role}")
    print()
    if args.grant_iam and not args.principal:
        print("IAM grants are skipped because --principal was not provided.")
        print("Pass --principal serviceAccount:name@project.iam.gserviceaccount.com")
        print("or --principal user:name@example.com to configure runtime IAM.")
        print()
    for index, step in enumerate(steps, start=1):
        print(f"{index}. {step.label}")
        if step.command:
            print(f"   {_quote_command(step.command)}")
        elif step.action:
            print(f"   python action: {step.detail or 'run setup action'}")
    print()


def run(args: argparse.Namespace) -> int:
    if args.service_account and not args.principal:
        email = _service_account_email(args.project, args.service_account)
        args.principal = f"serviceAccount:{email}"
    _require_project_dataset(args)
    preflight = _run_preflight()
    _print_preflight(preflight, args)
    steps = _build_steps(args)
    if args.execute:
        if not preflight.gcloud_available:
            raise SystemExit(
                "gcloud is required for --execute but is not available. "
                "Install the Google Cloud SDK and re-run."
            )
        if _steps_need_adc(steps) and not preflight.adc_ok:
            raise SystemExit(
                "Application Default Credentials are not configured but "
                "this plan calls google-cloud-bigquery directly. "
                "Run: gcloud auth application-default login "
                "(or set GOOGLE_APPLICATION_CREDENTIALS to a service-"
                "account JSON key) and re-run."
            )
        if _steps_need_cli_auth(steps) and not preflight.cli_auth_ok:
            raise SystemExit(
                "gcloud CLI auth is not configured but this plan shells "
                "out to gcloud / bq. "
                "Run: gcloud auth login (and `gcloud config set account "
                "ACCOUNT` if multiple identities are listed) and re-run. "
                "ADC alone is not enough: gcloud subcommands ignore ADC "
                "and use the active CLI account."
            )
    _print_plan(args, steps)
    if not args.execute:
        print("No changes made. Re-run with --execute to apply this plan.")
        return 0
    for step in steps:
        print(f"==> {step.label}")
        if step.command:
            subprocess.run(step.command, check=True)
        elif step.action:
            step.action()
    print("BQAA GCP prerequisites completed.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Set up GCP APIs, IAM, dataset, and table for BQAA tracing."
    )
    parser.add_argument("--project", default=_default_project())
    parser.add_argument("--dataset", default=_default_dataset())
    parser.add_argument("--table", default=_default_table())
    parser.add_argument("--location", default=os.environ.get("BQAA_LOCATION") or "US")
    parser.add_argument(
        "--principal",
        help=(
            "Runtime IAM member to grant, e.g. "
            "serviceAccount:bqaa-writer@PROJECT.iam.gserviceaccount.com or "
            "user:person@example.com"
        ),
    )
    parser.add_argument(
        "--service-account",
        metavar="NAME_OR_EMAIL",
        help=(
            "Create this service account if missing and grant it runtime IAM. "
            "Use an account id such as bqaa-writer or a full service account email."
        ),
    )
    parser.add_argument(
        "--writer-role",
        choices=("data-editor", "row-writer"),
        default="data-editor",
        help=(
            "What the runtime principal gets. data-editor (default): dataset "
            "dataEditor and project jobUser, enough for the tracing plugin's "
            "verification queries. row-writer: a custom role with "
            "bigquery.tables.updateData and bigquery.tables.get on the table "
            "alone (inserts only: no reads, queries or deletes)."
        ),
    )
    parser.add_argument(
        "--token-creator",
        action="append",
        default=[],
        metavar="MEMBER",
        help=(
            "Grant roles/iam.serviceAccountTokenCreator on --service-account to "
            "this member (best a group:), so it can impersonate the writer. Repeatable."
        ),
    )
    parser.add_argument(
        "--reader",
        action="append",
        default=[],
        metavar="MEMBER",
        help=(
            "Grant this member (best a group:) dataViewer on the views dataset and "
            "project jobUser, and authorize the views on the events dataset, so "
            "readers need no access to the table. Repeatable."
        ),
    )
    parser.add_argument(
        "--allow-existing-grants",
        action="store_true",
        help=(
            "With --writer-role row-writer: keep a writer that already holds other "
            "grants on the project, the datasets or the table (an audited account). "
            "Without it, setup stops before granting anything."
        ),
    )
    parser.add_argument(
        "--views-dataset",
        default=os.environ.get("BQAA_VIEWS_DATASET") or "",
        help="The views dataset (default: <dataset>_reporting).",
    )
    parser.add_argument("--execute", action="store_true", help="Apply the printed plan.")
    parser.add_argument(
        "--no-enable-apis",
        dest="enable_apis",
        action="store_false",
        help="Do not enable BigQuery APIs.",
    )
    parser.add_argument(
        "--no-create-dataset",
        dest="create_dataset",
        action="store_false",
        help="Do not create the dataset if missing.",
    )
    parser.add_argument(
        "--no-create-table",
        dest="create_table",
        action="store_false",
        help="Do not create the agent_events table if missing.",
    )
    parser.add_argument(
        "--no-grant-iam",
        dest="grant_iam",
        action="store_false",
        help="Do not grant runtime IAM roles.",
    )
    parser.add_argument(
        "--runtime-auto-create-dataset",
        action="store_true",
        help=(
            "Also grant roles/bigquery.user so the runtime principal can create "
            "datasets when BQAA_AUTO_CREATE_DATASET=true."
        ),
    )
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help=(
            "Run without interactive prompts. Adds --quiet to every gcloud "
            "and bq subcommand so Codex / Claude / CI can run --execute "
            "unattended without a confirmation hanging the bootstrap."
        ),
    )
    parser.set_defaults(
        enable_apis=True,
        create_dataset=True,
        create_table=True,
        grant_iam=True,
        non_interactive=False,
    )
    return run(parser.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
