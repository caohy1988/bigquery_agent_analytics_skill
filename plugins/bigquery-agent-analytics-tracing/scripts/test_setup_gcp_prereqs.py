#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import io
import json
from pathlib import Path
import subprocess
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
        "writer_role": "data-editor",
        "token_creator": [],
        "reader": [],
        "views_dataset": "",
        "allow_existing_grants": False,
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
        "--project_id=test-project",
        "query",
        "--use_legacy_sql=false",
        "--location=US",
        'GRANT `roles/bigquery.dataEditor` ON SCHEMA `test-project.agent_analytics` '
        'TO "serviceAccount:bqaa-writer@test-project.iam.gserviceaccount.com"',
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
            "--project_id=test-project",
            "query",
            "--use_legacy_sql=false",
            "--location=US",
            'GRANT `roles/bigquery.dataEditor` ON SCHEMA `test-project.agent_analytics` TO "user:foo@example.com"',
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
    steps = setup._build_steps(args)
    assert not setup._steps_need_cli_auth(steps), steps
    assert setup._steps_need_adc(steps), steps


def test_service_account_only_plan_needs_cli_auth_not_adc() -> None:
    # Reviewer Finding #2 regression: a plan with ONLY the
    # service-account step (no dataset/table create, no IAM grants)
    # is a Step.action that shells out to gcloud — must trigger
    # CLI-auth gating, must NOT trigger ADC gating. The prior heuristic
    # `any(step.action is not None)` got this wrong.
    args = _args(
        execute=True,
        enable_apis=False,
        create_dataset=False,
        create_table=False,
        grant_iam=False,
        service_account="bqaa-writer",
    )
    if args.service_account and not args.principal:
        email = setup._service_account_email(args.project, args.service_account)
        args.principal = f"serviceAccount:{email}"
    steps = setup._build_steps(args)
    assert len(steps) == 1, steps
    assert steps[0].action is not None
    assert steps[0].needs_cli_auth, "SA action shells out to gcloud"
    assert not steps[0].needs_adc, "SA action doesn't use ADC"
    # And the gating helpers reflect the same:
    assert setup._steps_need_cli_auth(steps)
    assert not setup._steps_need_adc(steps)


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



def test_row_writer_plan_grants_the_custom_role_on_the_table_alone() -> None:
    args = _args(service_account="bqaa-writer", writer_role="row-writer")
    commands = _commands(args)
    labels = _labels(args) if "_labels" in globals() else []
    joined = [" ".join(c) for c in commands]
    assert any(
        c == [
            "bq", "add-iam-policy-binding",
            "--member", "serviceAccount:bqaa-writer@test-project.iam.gserviceaccount.com",
            "--role", "projects/test-project/roles/bqaaRowWriter",
            "test-project:agent_analytics.agent_events",
        ]
        for c in commands
    ), joined
    assert not any("roles/bigquery.dataEditor" in j for j in joined)
    assert not any("roles/bigquery.jobUser" in j for j in joined)
    steps = setup._build_steps(args)
    role_steps = [s for s in steps if s.label.startswith("Ensure role projects/test-project/roles/bqaaRowWriter")]
    assert len(role_steps) == 1 and role_steps[0].action is not None and role_steps[0].needs_cli_auth
    assert setup.ROW_WRITER_PERMISSIONS == ("bigquery.tables.get", "bigquery.tables.updateData")
    # The writer's grants are checked before the role and its binding, and
    # the binding comes after the table exists.
    order = [s.label for s in steps]
    check = "Check that serviceAccount:bqaa-writer@test-project.iam.gserviceaccount.com holds nothing beyond the row-writer role"
    assert order.index(check) < order.index(role_steps[0].label)
    assert order.index("Grant the row-writer role to runtime principal, on the table alone") > order.index(
        "Ensure table test-project.agent_analytics.agent_events"
    )


def test_default_writer_role_is_unchanged() -> None:
    joined = [" ".join(c) for c in _commands(_args(service_account="bqaa-writer"))]
    assert any("roles/bigquery.dataEditor" in j for j in joined)
    assert any("roles/bigquery.jobUser" in j for j in joined)
    assert not any("bqaaRowWriter" in j for j in joined)


def test_token_creators_get_a_binding_each_on_the_service_account() -> None:
    args = _args(service_account="bqaa-writer", writer_role="row-writer",
                 token_creator=["group:bqaa-users@example.com", "user:lead@example.com"])
    setup._require_project_dataset(args)
    steps = [s for s in setup._build_steps(args) if s.label.startswith("Grant token creation")]
    assert [s.label for s in steps] == [
        "Grant token creation on bqaa-writer@test-project.iam.gserviceaccount.com to group:bqaa-users@example.com",
        "Grant token creation on bqaa-writer@test-project.iam.gserviceaccount.com to user:lead@example.com",
    ]
    assert all(s.action is not None and s.needs_cli_auth for s in steps)
    assert "--role roles/iam.serviceAccountTokenCreator" in steps[0].detail
    assert "--member group:bqaa-users@example.com" in steps[0].detail


def test_token_creator_needs_a_service_account() -> None:
    try:
        setup._require_project_dataset(_args(token_creator=["group:bqaa-users@example.com"]))
    except SystemExit as exc:
        assert "--service-account" in str(exc)
    else:
        raise AssertionError("expected SystemExit")


def test_members_must_name_their_kind() -> None:
    for field in ("token_creator", "reader"):
        overrides = {field: ["bqaa-users@example.com"]}
        if field == "token_creator":
            overrides["service_account"] = "bqaa-writer"
        try:
            setup._require_project_dataset(_args(**overrides))
        except SystemExit as exc:
            assert "user:, group:, serviceAccount: or domain:" in str(exc)
        else:
            raise AssertionError(f"expected SystemExit for {field}")


def test_readers_get_the_views_dataset_and_jobs_and_the_views_are_authorized() -> None:
    args = _args(reader=["group:bqaa-readers@example.com"])
    joined = [" ".join(c) for c in _commands(args)]
    assert "bq --project_id=test-project query --use_legacy_sql=false --location=US GRANT `roles/bigquery.dataViewer` ON SCHEMA `test-project.agent_analytics_reporting` TO \"group:bqaa-readers@example.com\"".replace('\\"', '"') in joined
    assert "gcloud projects add-iam-policy-binding test-project --member group:bqaa-readers@example.com --role roles/bigquery.jobUser" in joined
    # No grant on the events dataset or table for readers.
    assert not any("group:bqaa-readers@example.com" in j and "agent_analytics " in j + " " and "_reporting" not in j and "projects add-iam-policy-binding" not in j for j in joined)
    authorize = [s for s in setup._build_steps(args) if s.label.startswith("Authorize the views")]
    assert len(authorize) == 1 and authorize[0].needs_adc


def test_views_dataset_can_be_named() -> None:
    joined = [" ".join(c) for c in _commands(_args(reader=["group:r@example.com"], views_dataset="reports"))]
    assert any("`test-project.reports`" in j for j in joined)


def test_dataset_grants_use_the_grant_statement_not_add_iam_policy_binding() -> None:
    # bq add-iam-policy-binding -d needs allowlisting, and drops --member
    # and --role after a positional argument: every dataset grant is a GRANT.
    for args in (_args(principal="user:dev@example.com"), _args(reader=["group:r@example.com"])):
        joined = [" ".join(c) for c in _commands(args)]
        assert not any("add-iam-policy-binding -d" in j for j in joined), joined
        assert any("ON SCHEMA" in j for j in joined), joined


def test_dataset_grant_refuses_quotes() -> None:
    try:
        setup._dataset_grant_command(_args(), "agent_analytics", 'group:a"b@example.com', "roles/bigquery.dataViewer")
    except SystemExit:
        pass
    else:
        raise AssertionError("expected SystemExit")


class _FakeRun:
    """Stands in for subprocess.run: answers by the words a command holds,
    and logs every command."""

    def __init__(self, answers: list[tuple[tuple[str, ...], int, str]]) -> None:
        self.answers = answers
        self.calls: list[list[str]] = []

    def __call__(self, command, *args, check=False, **kwargs):
        command = list(command)
        self.calls.append(command)
        code, out = 0, ""
        for words, answer_code, answer_out in self.answers:
            if all(word in command for word in words):
                code, out = answer_code, answer_out
                break
        if check and code != 0:
            raise subprocess.CalledProcessError(code, command)
        return subprocess.CompletedProcess(command, code, out, "")


@contextlib.contextmanager
def _stub_run(fake: _FakeRun):
    original = setup.subprocess.run
    setup.subprocess.run = fake
    try:
        yield fake
    finally:
        setup.subprocess.run = original


WRITER = "bqaa-row-writer@test-project.iam.gserviceaccount.com"
CLEAN_ROLE = json.dumps({"includedPermissions": ["bigquery.tables.get", "bigquery.tables.updateData"]})


def _row_writer_run(fake: _FakeRun, **overrides: object) -> None:
    args = _args(
        service_account="bqaa-row-writer", writer_role="row-writer", execute=True,
        create_dataset=False, create_table=False, token_creator=["group:bqaa-writers@example.com"],
        **overrides,
    )
    with _stub_preflight(_preflight()), _stub_run(fake), contextlib.redirect_stdout(io.StringIO()):
        setup.run(args)


def _answers(project_policy: dict, dataset: dict, table_policy: dict, role: str = CLEAN_ROLE):
    return [
        (("gcloud", "projects", "get-iam-policy"), 0, json.dumps(project_policy)),
        (("bq", "show", "test-project:agent_analytics"), 0, json.dumps(dataset)),
        (("bq", "show", "test-project:agent_analytics_reporting"), 2, "BigQuery error in show operation: Not found: Dataset"),
        (("bq", "get-iam-policy"), 0, json.dumps(table_policy)),
        (("gcloud", "iam", "roles", "describe"), 0, role),
    ]


def _token_creator_calls(fake: _FakeRun) -> list[list[str]]:
    return [c for c in fake.calls if "roles/iam.serviceAccountTokenCreator" in c]


def test_a_reused_writer_with_other_grants_is_refused_before_any_grant() -> None:
    # An account an earlier setup gave dataset dataEditor and project jobUser
    # (the tracing plugin's default) would hand every token creator a read
    # of every row.
    fake = _FakeRun(_answers(
        {"bindings": [{"role": "roles/bigquery.jobUser", "members": [f"serviceAccount:{WRITER}"]}]},
        {"access": [{"role": "roles/bigquery.dataEditor", "userByEmail": WRITER.upper()}]},
        {"bindings": [{"role": "roles/bigquery.dataViewer", "members": [f"serviceAccount:{WRITER}"]}]},
    ))
    try:
        _row_writer_run(fake)
    except SystemExit as exc:
        message = str(exc)
        assert "roles/bigquery.jobUser on the project test-project" in message
        assert "roles/bigquery.dataEditor on the dataset test-project.agent_analytics" in message
        assert "roles/bigquery.dataViewer on the table test-project.agent_analytics.agent_events" in message
        assert "--allow-existing-grants" in message
    else:
        raise AssertionError("expected SystemExit")
    assert not _token_creator_calls(fake)
    assert not any("add-iam-policy-binding" in c for c in fake.calls)


def test_allow_existing_grants_keeps_an_audited_writer() -> None:
    fake = _FakeRun(_answers(
        {"bindings": [{"role": "roles/bigquery.jobUser", "members": [f"serviceAccount:{WRITER}"]}]}, {}, {},
    ))
    _row_writer_run(fake, allow_existing_grants=True)
    assert len(_token_creator_calls(fake)) == 1


def test_a_clean_writer_gets_the_role_on_the_table_and_its_token_creators() -> None:
    fake = _FakeRun(_answers(
        {"bindings": [{"role": "roles/bigquery.jobUser", "members": ["user:someone@example.com"]}]},
        {"access": [{"role": "OWNER", "specialGroup": "projectOwners"}, {"view": {"tableId": "v"}}]},
        {"bindings": [{"role": "projects/test-project/roles/bqaaRowWriter", "members": [f"serviceAccount:{WRITER}"]}]},
    ))
    _row_writer_run(fake)
    assert len(_token_creator_calls(fake)) == 1
    assert any(c[:2] == ["bq", "add-iam-policy-binding"] and "projects/test-project/roles/bqaaRowWriter" in c for c in fake.calls)
    assert not any("update" in c and "roles" in c for c in fake.calls)


def test_a_row_writer_role_holding_more_is_refused_before_any_grant() -> None:
    role = json.dumps({"includedPermissions": ["bigquery.tables.get", "bigquery.tables.getData", "bigquery.tables.updateData"]})
    fake = _FakeRun(_answers({}, {}, {}, role=role))
    try:
        _row_writer_run(fake)
    except SystemExit as exc:
        assert "also holds bigquery.tables.getData" in str(exc)
        assert "--remove-permissions bigquery.tables.getData" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert not _token_creator_calls(fake)
    assert not any("add-iam-policy-binding" in c for c in fake.calls)


def test_a_row_writer_role_lacking_a_permission_gets_only_that_one() -> None:
    fake = _FakeRun(_answers({}, {}, {}, role=json.dumps({"includedPermissions": ["bigquery.tables.updateData"]})))
    _row_writer_run(fake)
    updates = [c for c in fake.calls if c[1:4] == ["iam", "roles", "update"]]
    assert len(updates) == 1 and updates[0][updates[0].index("--add-permissions") + 1] == "bigquery.tables.get"
    assert len(_token_creator_calls(fake)) == 1


def test_a_deleted_row_writer_role_is_refused() -> None:
    fake = _FakeRun(_answers({}, {}, {}, role=json.dumps({"deleted": True, "includedPermissions": list(setup.ROW_WRITER_PERMISSIONS)})))
    try:
        _row_writer_run(fake)
    except SystemExit as exc:
        assert "undelete" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert not _token_creator_calls(fake)


def test_token_creators_enable_the_iam_credentials_api() -> None:
    args = _args(service_account="bqaa-row-writer", writer_role="row-writer", token_creator=["group:w@example.com"])
    enable = _commands(args)[0]
    assert enable[:3] == ["gcloud", "services", "enable"] and "iamcredentials.googleapis.com" in enable
    assert "iamcredentials.googleapis.com" not in _commands(_args(service_account="bqaa-row-writer"))[0]


def test_without_enabling_apis_the_iam_credentials_api_is_checked() -> None:
    args = _args(service_account="bqaa-row-writer", writer_role="row-writer",
                 token_creator=["group:w@example.com"], enable_apis=False)
    labels = _labels(args)
    check = labels.index("Check that iamcredentials.googleapis.com is enabled")
    assert check < labels.index(f"Grant token creation on {WRITER} to group:w@example.com")
    fake = _FakeRun([(("services", "list"), 0, "")])
    with _stub_run(fake):
        try:
            setup._check_api_enabled(args, "iamcredentials.googleapis.com")
        except SystemExit as exc:
            assert "gcloud services enable iamcredentials.googleapis.com" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
    with _stub_run(_FakeRun([(("services", "list"), 0, "iamcredentials.googleapis.com\n")])), contextlib.redirect_stdout(io.StringIO()):
        setup._check_api_enabled(args, "iamcredentials.googleapis.com")


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
        test_service_account_only_plan_needs_cli_auth_not_adc,
        test_preflight_failure_does_not_block_dry_run,
        test_preflight_missing_gcloud_blocks_execute,
        test_summarize_stderr_keeps_actionable_context,
        test_row_writer_plan_grants_the_custom_role_on_the_table_alone,
        test_default_writer_role_is_unchanged,
        test_token_creators_get_a_binding_each_on_the_service_account,
        test_token_creator_needs_a_service_account,
        test_members_must_name_their_kind,
        test_readers_get_the_views_dataset_and_jobs_and_the_views_are_authorized,
        test_views_dataset_can_be_named,
        test_dataset_grants_use_the_grant_statement_not_add_iam_policy_binding,
        test_dataset_grant_refuses_quotes,
        test_a_reused_writer_with_other_grants_is_refused_before_any_grant,
        test_allow_existing_grants_keeps_an_audited_writer,
        test_a_clean_writer_gets_the_role_on_the_table_and_its_token_creators,
        test_a_row_writer_role_holding_more_is_refused_before_any_grant,
        test_a_row_writer_role_lacking_a_permission_gets_only_that_one,
        test_a_deleted_row_writer_role_is_refused,
        test_token_creators_enable_the_iam_credentials_api,
        test_without_enabling_apis_the_iam_credentials_api_is_checked,
    ):
        test()
    print("setup_gcp_prereqs tests passed")
