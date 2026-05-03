#!/usr/bin/env python3
"""Bootstrap Google Cloud prerequisites for BQAA tracing.

The script is intentionally dry-run by default. Pass --execute when the printed
plan looks right. It uses the caller's current Google Cloud credentials for
setup, and grants narrower runtime roles to --principal when provided.
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SDK_PATH = PLUGIN_ROOT / "sdk" / "python"
sys.path.insert(0, str(SDK_PATH))

from bqaa_tracing import bq_schema  # noqa: E402


BIGQUERY_API_SERVICES = ("bigquery.googleapis.com", "bigquerystorage.googleapis.com")


@dataclass(frozen=True)
class Step:
    label: str
    command: list[str] | None = None
    action: Callable[[], None] | None = None


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


def _ensure_service_account(project: str, value: str) -> None:
    email = _service_account_email(project, value)
    describe = subprocess.run(
        [
            "gcloud",
            "iam",
            "service-accounts",
            "describe",
            email,
            "--project",
            project,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if describe.returncode == 0:
        print(f"OK service account exists: {email}")
        return
    subprocess.run(
        [
            "gcloud",
            "iam",
            "service-accounts",
            "create",
            _service_account_id(value),
            "--project",
            project,
            "--display-name",
            "BQAA tracing writer",
        ],
        check=True,
    )
    print(f"CREATED service account: {email}")


def _require_project_dataset(args: argparse.Namespace) -> None:
    if not args.project:
        raise SystemExit(
            "--project is required, or set BQAA_PROJECT_ID/GCP_PROJECT_ID/GOOGLE_CLOUD_PROJECT"
        )
    if not args.dataset:
        raise SystemExit("--dataset is required, or set BQAA_DATASET")


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
        steps.append(
            Step(
                "Enable Google Cloud APIs",
                [
                    "gcloud",
                    "services",
                    "enable",
                    *services,
                    "--project",
                    args.project,
                ],
            )
        )

    if args.service_account:
        steps.append(
            Step(
                f"Ensure service account {_service_account_email(args.project, args.service_account)}",
                action=lambda: _ensure_service_account(args.project, args.service_account),
            )
        )

    if args.create_dataset:
        steps.append(
            Step(
                f"Ensure dataset {args.project}.{args.dataset}",
                action=lambda: _ensure_dataset(args.project, args.dataset, args.location),
            )
        )

    if args.create_table:
        steps.append(
            Step(
                f"Ensure table {args.project}.{args.dataset}.{args.table}",
                action=lambda: _ensure_table(
                    args.project, args.dataset, args.table, args.location
                ),
            )
        )

    if args.grant_iam and args.principal:
        steps.extend(
            [
                Step(
                    "Grant dataset dataEditor to runtime principal",
                    [
                        "bq",
                        "add-iam-policy-binding",
                        f"{args.project}:{args.dataset}",
                        "--member",
                        args.principal,
                        "--role",
                        "roles/bigquery.dataEditor",
                    ],
                ),
                Step(
                    "Grant project jobUser for verification queries",
                    [
                        "gcloud",
                        "projects",
                        "add-iam-policy-binding",
                        args.project,
                        "--member",
                        args.principal,
                        "--role",
                        "roles/bigquery.jobUser",
                    ],
                ),
            ]
        )
        if args.runtime_auto_create_dataset:
            steps.append(
                Step(
                    "Grant project bigquery.user for runtime dataset creation",
                    [
                        "gcloud",
                        "projects",
                        "add-iam-policy-binding",
                        args.project,
                        "--member",
                        args.principal,
                        "--role",
                        "roles/bigquery.user",
                    ],
                )
            )
    return steps


def _print_plan(args: argparse.Namespace, steps: list[Step]) -> None:
    mode = "EXECUTE" if args.execute else "DRY RUN"
    print(f"BQAA GCP prerequisite bootstrap ({mode})")
    print(f"project:  {args.project}")
    print(f"dataset:  {args.dataset}")
    print(f"table:    {args.table}")
    print(f"location: {args.location or '(client default)'}")
    principal = args.principal or "(IAM grants skipped)"
    print(f"principal: {principal}")
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
            print("   python action")
    print()


def run(args: argparse.Namespace) -> int:
    _require_project_dataset(args)
    if args.service_account and not args.principal:
        email = _service_account_email(args.project, args.service_account)
        args.principal = f"serviceAccount:{email}"
    steps = _build_steps(args)
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
    parser.set_defaults(
        enable_apis=True,
        create_dataset=True,
        create_table=True,
        grant_iam=True,
    )
    return run(parser.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
