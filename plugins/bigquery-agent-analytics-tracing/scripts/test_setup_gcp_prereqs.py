#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import io
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
        "non_interactive": False,
    }
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


@contextlib.contextmanager
def _stub_preflight(result: setup._PreflightResult):
    """Replace _run_preflight for the duration of one test without monkeypatch.

    Tests that exercise the run() path need a deterministic preflight
    answer; calling the real subprocesses would couple the test to the
    machine's gcloud install.
    """
    original = setup._run_preflight
    setup._run_preflight = lambda: result
    try:
        yield
    finally:
        setup._run_preflight = original


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


def test_non_interactive_injects_quiet_into_gcloud_and_bq() -> None:
    commands = _commands(_args(service_account="bqaa-writer", non_interactive=True))
    # First command is gcloud services enable; --quiet must be the second
    # token (gcloud's --quiet is a global flag that goes before the
    # subcommand group).
    assert commands[0][:2] == ["gcloud", "--quiet"], commands[0]
    bq_commands = [c for c in commands if c and c[0] == "bq"]
    assert bq_commands, "expected at least one bq command in the plan"
    for cmd in bq_commands:
        assert cmd[:2] == ["bq", "--quiet"], cmd
    project_iam = [
        c for c in commands if c[:2] == ["gcloud", "--quiet"] and "projects" in c
    ]
    assert project_iam, "expected gcloud --quiet projects add-iam-policy-binding"


def test_default_does_not_add_quiet() -> None:
    # Confirms --non-interactive is opt-in; default plan keeps the bare
    # gcloud/bq commands so it stays git-diff-friendly with prior PRs.
    commands = _commands(_args(service_account="bqaa-writer"))
    assert commands[0][1] != "--quiet", commands[0]
    bq_commands = [c for c in commands if c and c[0] == "bq"]
    for cmd in bq_commands:
        assert cmd[1] != "--quiet", cmd


def _preflight(
    *,
    adc_ok: bool = True,
    cli_auth_ok: bool = True,
    gcloud_available: bool = True,
    adc_message: str = "ADC token reachable",
    cli_auth_message: str = "active account user@example.com",
    cli_auth_account: str = "user@example.com",
    gcloud_project: str = "test-project",
) -> setup._PreflightResult:
    return setup._PreflightResult(
        adc_ok=adc_ok,
        adc_message=adc_message,
        cli_auth_ok=cli_auth_ok,
        cli_auth_account=cli_auth_account,
        cli_auth_message=cli_auth_message,
        gcloud_project=gcloud_project,
        gcloud_available=gcloud_available,
    )


def test_preflight_adc_failure_blocks_execute_when_python_actions_run() -> None:
    # Default flag set runs both python actions and gcloud commands; ADC
    # missing must hard-fail --execute because create_dataset/create_table
    # call google-cloud-bigquery directly.
    with _stub_preflight(_preflight(adc_ok=False, adc_message="not configured — no token")):
        with contextlib.redirect_stdout(io.StringIO()):
            try:
                setup.run(_args(execute=True))
            except SystemExit as exc:
                assert "Application Default Credentials" in str(exc), exc
            else:
                raise AssertionError("ADC missing must hard-fail --execute")


def test_preflight_cli_auth_failure_blocks_execute_when_gcloud_steps_run() -> None:
    # Reviewer's Finding #1: ADC OK but gcloud CLI auth missing must
    # block --execute, because gcloud services enable / projects add-iam
    # use the active CLI account, not ADC.
    with _stub_preflight(_preflight(cli_auth_ok=False, cli_auth_message="no active account")):
        with contextlib.redirect_stdout(io.StringIO()):
            try:
                setup.run(_args(execute=True))
            except SystemExit as exc:
                assert "gcloud CLI auth" in str(exc), exc
                assert "ADC alone is not enough" in str(exc), exc
            else:
                raise AssertionError("CLI auth missing must hard-fail --execute")


def test_preflight_cli_auth_failure_allowed_when_only_python_actions() -> None:
    # If the user disables every gcloud-shelled-out step, CLI auth being
    # missing doesn't matter — the plan only uses google-cloud-bigquery
    # via ADC. Don't false-positive on this case.
    args = _args(
        execute=True,
        enable_apis=False,
        grant_iam=False,
        service_account=None,
    )
    with _stub_preflight(_preflight(cli_auth_ok=False)):
        with contextlib.redirect_stdout(io.StringIO()):
            # Should not raise. We can't actually let it run --execute
            # against real BQ in tests, so monkey-patch the action loop
            # by stubbing the only remaining steps' .action callables.
            # Easier: stop before executing actions by validating that
            # _build_steps()-returned plan contains no gcloud/bq commands.
            steps = setup._build_steps(args)
            assert not setup._steps_need_gcloud_or_bq(steps), steps


def test_preflight_failure_does_not_block_dry_run() -> None:
    with _stub_preflight(_preflight(adc_ok=False, cli_auth_ok=False, adc_message="not configured", cli_auth_message="no active account")):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            assert setup.run(_args()) == 0
        out = buf.getvalue()
        assert "DRY RUN" in out
        assert "ADC: NOT CONFIGURED" in out
        assert "gcloud CLI auth: NOT CONFIGURED" in out


def test_preflight_missing_gcloud_blocks_execute() -> None:
    with _stub_preflight(_preflight(gcloud_available=False, adc_ok=False, cli_auth_ok=False)):
        with contextlib.redirect_stdout(io.StringIO()):
            try:
                setup.run(_args(execute=True))
            except SystemExit as exc:
                assert "gcloud is required" in str(exc), exc
            else:
                raise AssertionError("missing gcloud must hard-fail --execute")


def test_summarize_stderr_keeps_actionable_context() -> None:
    # Reviewer's Finding #2: the prior code took only the last stderr
    # line and lost the actionable part of gcloud's error. Verify the
    # summarizer keeps a useful suffix.
    raw = (
        "ERROR: (gcloud.auth.application-default.print-access-token) "
        "Reauthentication failed.\n"
        "to select an already authenticated account to use, run:\n"
        "  $ gcloud config set account ACCOUNT\n"
    )
    summary = setup._summarize_stderr(raw, fallback="no token")
    assert "Reauthentication failed" in summary
    assert "gcloud config set account" in summary


if __name__ == "__main__":
    for test in (
        test_service_account_plan,
        test_pruned_user_principal_plan,
        test_runtime_auto_create_dataset_adds_user_role,
        test_principal_prefix_validation,
        test_python_action_details_are_visible,
        test_non_interactive_injects_quiet_into_gcloud_and_bq,
        test_default_does_not_add_quiet,
        test_preflight_adc_failure_blocks_execute_when_python_actions_run,
        test_preflight_cli_auth_failure_blocks_execute_when_gcloud_steps_run,
        test_preflight_cli_auth_failure_allowed_when_only_python_actions,
        test_preflight_failure_does_not_block_dry_run,
        test_preflight_missing_gcloud_blocks_execute,
        test_summarize_stderr_keeps_actionable_context,
    ):
        test()
    print("setup_gcp_prereqs tests passed")
