#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
import sys

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import setup_gcp_prereqs as setup  # noqa: E402


def _args(**overrides: object) -> argparse.Namespace:
    defaults = {
        "project": "test-project",
        "dataset": "agent_analytics",
        "table": "agent_events",
        "location": "US",
        "principal": None,
        "service_account": None,
        "execute": False,
        "enable_apis": True,
        "create_dataset": True,
        "create_table": True,
        "grant_iam": True,
        "runtime_auto_create_dataset": False,
    }
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


def _commands(args: argparse.Namespace) -> list[list[str]]:
    if args.service_account and not args.principal:
        email = setup._service_account_email(args.project, args.service_account)
        args.principal = f"serviceAccount:{email}"
    setup._require_project_dataset(args)
    return [step.command for step in setup._build_steps(args) if step.command]


def _labels(args: argparse.Namespace) -> list[str]:
    if args.service_account and not args.principal:
        email = setup._service_account_email(args.project, args.service_account)
        args.principal = f"serviceAccount:{email}"
    setup._require_project_dataset(args)
    return [step.label for step in setup._build_steps(args)]


def test_service_account_plan() -> None:
    args = _args(service_account="bqaa-writer")
    assert _labels(args) == [
        "Enable Google Cloud APIs",
        "Ensure service account bqaa-writer@test-project.iam.gserviceaccount.com",
        "Ensure dataset test-project.agent_analytics",
        "Ensure table test-project.agent_analytics.agent_events",
        "Grant dataset dataEditor to runtime principal",
        "Grant project jobUser for verification queries",
    ]
    commands = _commands(_args(service_account="bqaa-writer"))
    assert commands[0] == [
        "gcloud",
        "services",
        "enable",
        "bigquery.googleapis.com",
        "bigquerystorage.googleapis.com",
        "iam.googleapis.com",
        "--project",
        "test-project",
    ]
    assert commands[1] == [
        "bq",
        "add-iam-policy-binding",
        "-d",
        "test-project:agent_analytics",
        "--member",
        "serviceAccount:bqaa-writer@test-project.iam.gserviceaccount.com",
        "--role",
        "roles/bigquery.dataEditor",
    ]
    assert commands[2][-2:] == ["--role", "roles/bigquery.jobUser"]


def test_pruned_user_principal_plan() -> None:
    commands = _commands(
        _args(
            principal="user:foo@example.com",
            enable_apis=False,
            create_table=False,
        )
    )
    assert commands == [
        [
            "bq",
            "add-iam-policy-binding",
            "-d",
            "test-project:agent_analytics",
            "--member",
            "user:foo@example.com",
            "--role",
            "roles/bigquery.dataEditor",
        ],
        [
            "gcloud",
            "projects",
            "add-iam-policy-binding",
            "test-project",
            "--member",
            "user:foo@example.com",
            "--role",
            "roles/bigquery.jobUser",
        ],
    ]


def test_runtime_auto_create_dataset_adds_user_role() -> None:
    commands = _commands(
        _args(
            principal="serviceAccount:bqaa-writer@test-project.iam.gserviceaccount.com",
            runtime_auto_create_dataset=True,
        )
    )
    assert commands[-1] == [
        "gcloud",
        "projects",
        "add-iam-policy-binding",
        "test-project",
        "--member",
        "serviceAccount:bqaa-writer@test-project.iam.gserviceaccount.com",
        "--role",
        "roles/bigquery.user",
    ]


def test_principal_prefix_validation() -> None:
    setup._validate_principal("user:foo@example.com")
    setup._validate_principal("serviceAccount:writer@test-project.iam.gserviceaccount.com")
    setup._validate_principal("principal://iam.googleapis.com/projects/123/locations/global")
    setup._validate_principal("allUsers")
    try:
        setup._validate_principal("foo@example.com")
    except SystemExit as exc:
        assert "--principal must start" in str(exc)
    else:
        raise AssertionError("missing principal prefix should fail")
    try:
        setup._validate_principal("allUsers-but-not-really")
    except SystemExit as exc:
        assert "--principal must start" in str(exc)
    else:
        raise AssertionError("unknown principal token should fail")


def test_python_action_details_are_visible() -> None:
    steps = setup._build_steps(_args(service_account="bqaa-writer"))
    details = [step.detail for step in steps if step.action]
    assert all(details)
    assert "create service account" in str(details[0])
    assert "create_dataset(location=US)" in str(details[1])
    assert "bqaa_tracing.bq_schema()" in str(details[2])


if __name__ == "__main__":
    for test in (
        test_service_account_plan,
        test_pruned_user_principal_plan,
        test_runtime_auto_create_dataset_adds_user_role,
        test_principal_prefix_validation,
        test_python_action_details_are_visible,
    ):
        test()
    print("setup_gcp_prereqs tests passed")
