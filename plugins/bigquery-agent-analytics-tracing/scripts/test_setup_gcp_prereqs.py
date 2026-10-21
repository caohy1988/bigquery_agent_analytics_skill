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
        "accept_unverified": False,
        "keep_project_groups": False,
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
    importable = setup._bigquery_client_importable
    setup._run_preflight = lambda: result
    setup._bigquery_client_importable = lambda: True
    try:
        yield
    finally:
        setup._run_preflight = original
        setup._bigquery_client_importable = importable


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
            overrides.update(service_account="bqaa-writer", writer_role="row-writer")
        try:
            setup._require_project_dataset(_args(**overrides))
        except SystemExit as exc:
            assert "user:, group: or serviceAccount:" in str(exc)
        else:
            raise AssertionError(f"expected SystemExit for {field}")


def test_readers_get_the_views_dataset_and_jobs_and_the_views_are_authorized() -> None:
    args = _args(reader=["group:bqaa-readers@example.com"])
    joined = [" ".join(c) for c in _commands(args)]
    assert "bq --project_id=test-project query --use_legacy_sql=false --location=US GRANT `roles/bigquery.dataViewer` ON SCHEMA `test-project.agent_analytics_reporting` TO \"group:bqaa-readers@example.com\"".replace('\\"', '"') in joined
    assert "gcloud projects add-iam-policy-binding test-project --member group:bqaa-readers@example.com --role roles/bigquery.jobUser" in joined
    # No grant on the events dataset or table for readers.
    assert not any("group:bqaa-readers@example.com" in j and "agent_analytics " in j + " " and "_reporting" not in j and "projects add-iam-policy-binding" not in j for j in joined)
    authorize = [s for s in setup._build_steps(args) if s.label.startswith("Authorize ")]
    assert len(authorize) == 1 and authorize[0].needs_adc
    assert authorize[0].label.startswith("Authorize daily_usage_by_user, daily_usage_by_model of test-project.agent_analytics_reporting")


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
        else:
            if "check-transitive-membership" in command:
                # Unanswered here, as on most accounts (403): never "not a member".
                code, out = 1, "ERROR: (gcloud.identity.groups.memberships.check-transitive-membership) PERMISSION_DENIED"
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


@contextlib.contextmanager
def _views_left_alone():
    """A run that gets past the checks authorizes the views and, without
    --keep-project-groups, changes the datasets' access, both through the
    BigQuery client: stood in for here."""
    originals = setup._authorize_views, setup._restrict_dataset_access
    setup._authorize_views = lambda *args, **kwargs: None
    setup._restrict_dataset_access = lambda *args, **kwargs: None
    try:
        yield
    finally:
        setup._authorize_views, setup._restrict_dataset_access = originals


WRITER = "bqaa-row-writer@test-project.iam.gserviceaccount.com"
CLEAN_ROLE = json.dumps({"includedPermissions": ["bigquery.tables.get", "bigquery.tables.updateData"]})


def _row_writer_run(fake: _FakeRun, **overrides: object) -> None:
    settings = dict(
        service_account="bqaa-row-writer", writer_role="row-writer", execute=True,
        create_dataset=False, create_table=False, token_creator=["group:bqaa-writers@example.com"],
        keep_project_groups=True,
    )
    settings.update(overrides)
    args = _args(**settings)
    with _stub_preflight(_preflight()), _stub_run(fake), contextlib.redirect_stdout(io.StringIO()), _views_left_alone():
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


def test_token_creators_need_the_row_writer_role() -> None:
    # Impersonating an account that holds dataEditor reads every row.
    fake = _FakeRun([])
    args = _args(service_account="bqaa-writer", token_creator=["group:w@example.com"], execute=True)
    with _stub_preflight(_preflight()), _stub_run(fake), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup.run(args)
        except SystemExit as exc:
            assert "--writer-role row-writer" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
    assert fake.calls == []


def test_a_principal_other_than_the_service_account_is_refused() -> None:
    fake = _FakeRun([])
    args = _args(service_account="bqaa-row-writer", principal="serviceAccount:other@test-project.iam.gserviceaccount.com",
                 writer_role="row-writer", token_creator=["group:w@example.com"], execute=True)
    with _stub_preflight(_preflight()), _stub_run(fake), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup.run(args)
        except SystemExit as exc:
            assert "is not --service-account" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
    assert fake.calls == []
    # The same account, however its case is written, is fine.
    setup._require_project_dataset(_args(service_account="bqaa-row-writer", writer_role="row-writer",
                                         principal=f"serviceAccount:{WRITER.upper()}"))


def test_without_iam_grants_the_writer_and_its_role_are_still_checked_before_token_creators() -> None:
    args = _args(service_account="bqaa-row-writer", writer_role="row-writer", grant_iam=False,
                 token_creator=["group:w@example.com"])
    labels = _labels(args)
    check = labels.index(f"Check that serviceAccount:{WRITER} holds nothing beyond the row-writer role")
    role = labels.index("Check that role projects/test-project/roles/bqaaRowWriter, if there is one, "
                        "holds nothing beyond bigquery.tables.get, bigquery.tables.updateData")
    assert check < role < labels.index(f"Grant token creation on {WRITER} to group:w@example.com")
    assert not any(label.startswith(("Ensure role", "Grant the row-writer role")) for label in labels)
    # An account with other grants, or a role holding more, stops it.
    dirty = _FakeRun(_answers({"bindings": [{"role": "roles/bigquery.jobUser", "members": [f"serviceAccount:{WRITER}"]}]}, {}, {}))
    superset = _FakeRun(_answers({}, {}, {}, role=json.dumps(
        {"includedPermissions": ["bigquery.tables.get", "bigquery.tables.getData", "bigquery.tables.updateData"]})))
    for fake in (dirty, superset):
        try:
            _row_writer_run(fake, grant_iam=False)
        except SystemExit:
            pass
        else:
            raise AssertionError("expected SystemExit")
        assert not _token_creator_calls(fake)
    clean = _FakeRun(_answers({}, {}, {}))
    _row_writer_run(clean, grant_iam=False)
    assert len(_token_creator_calls(clean)) == 1
    assert not any(c[1:4] in (["iam", "roles", "create"], ["iam", "roles", "update"]) for c in clean.calls)
    assert not any(c[:2] == ["bq", "add-iam-policy-binding"] for c in clean.calls)


def test_a_views_dataset_that_is_the_events_dataset_is_refused_before_any_call() -> None:
    fake = _FakeRun([])
    args = _args(reader=["group:r@example.com"], views_dataset="agent_analytics", execute=True)
    with _stub_preflight(_preflight()), _stub_run(fake), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup.run(args)
        except SystemExit as exc:
            assert "the views dataset is the events dataset" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
    assert fake.calls == []


class _FakeClient:
    """Stands in for bigquery.Client: datasets and tables by id."""

    def __init__(self, datasets: dict, tables: dict) -> None:
        self.datasets, self.tables, self.updated = datasets, tables, []

    def get_dataset(self, ref):
        from google.cloud.exceptions import NotFound

        if ref not in self.datasets:
            raise NotFound(ref)
        return self.datasets[ref]

    def get_table(self, ref):
        from google.cloud.exceptions import NotFound

        if ref not in self.tables:
            raise NotFound(ref)
        return self.tables[ref]

    def update_dataset(self, dataset, fields):
        self.updated.append((dataset, list(fields)))


def _bigquery():
    try:
        from google.cloud import bigquery
    except ImportError:  # the Python BigQuery client is the bootstrap's own need
        return None
    return bigquery


def test_only_the_mods_views_are_authorized() -> None:
    bigquery = _bigquery()
    if bigquery is None:
        return
    from types import SimpleNamespace

    events = SimpleNamespace(access_entries=[bigquery.AccessEntry("OWNER", "specialGroup", "projectOwners")])

    def view(name: str) -> SimpleNamespace:
        return SimpleNamespace(project="test-project", dataset_id="agent_analytics_reporting", table_id=name, table_type="VIEW")

    client = _FakeClient(
        {"test-project.agent_analytics": events},
        {"test-project.agent_analytics_reporting.daily_usage_by_user": view("daily_usage_by_user"),
         "test-project.agent_analytics_reporting.daily_usage_by_model": view("daily_usage_by_model"),
         "test-project.agent_analytics_reporting.raw_rows": view("raw_rows")},
    )
    with contextlib.redirect_stdout(io.StringIO()):
        setup._authorize_views("test-project", "agent_analytics", "agent_analytics_reporting", client=client)
    authorized = sorted(e.entity_id["tableId"] for e in events.access_entries if e.entity_type == "view")
    assert authorized == ["daily_usage_by_model", "daily_usage_by_user"]
    # One of them missing: the other is authorized, and nothing else.
    events.access_entries = []
    del client.tables["test-project.agent_analytics_reporting.daily_usage_by_model"]
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        setup._authorize_views("test-project", "agent_analytics", "agent_analytics_reporting", client=client)
    assert [e.entity_id["tableId"] for e in events.access_entries] == ["daily_usage_by_user"]
    assert "no view daily_usage_by_model" in out.getvalue()


def test_the_project_groups_come_off_the_datasets() -> None:
    bigquery = _bigquery()
    if bigquery is None:
        return
    from types import SimpleNamespace

    entry = bigquery.AccessEntry
    events = SimpleNamespace(access_entries=[
        entry("READER", "specialGroup", "projectReaders"), entry("WRITER", "specialGroup", "projectWriters"),
        entry("OWNER", "specialGroup", "projectOwners"), entry("OWNER", "userByEmail", "admin@example.com"),
        entry(None, "view", {"projectId": "test-project", "datasetId": "agent_analytics_reporting", "tableId": "daily_usage_by_user"}),
        entry("READER", "iamMember", "allAuthenticatedUsers"),
    ])
    views = SimpleNamespace(access_entries=[
        entry("READER", "specialGroup", "projectReaders"), entry("WRITER", "specialGroup", "projectWriters"),
        entry("READER", "groupByEmail", "bqaa-readers@example.com"),
    ])
    client = _FakeClient({"test-project.agent_analytics": events, "test-project.agent_analytics_reporting": views}, {})
    with contextlib.redirect_stdout(io.StringIO()):
        setup._restrict_dataset_access("test-project", "agent_analytics", "agent_analytics_reporting", client=client)
    kept = [(e.entity_type, "view" if isinstance(e.entity_id, dict) else e.entity_id) for e in events.access_entries]
    assert kept == [("specialGroup", "projectOwners"), ("userByEmail", "admin@example.com"), ("view", "view")]
    assert [e.entity_id for e in views.access_entries] == ["projectReaders", "bqaa-readers@example.com"]
    # Run again: nothing to take off.
    client.updated.clear()
    with contextlib.redirect_stdout(io.StringIO()):
        setup._restrict_dataset_access("test-project", "agent_analytics", "agent_analytics_reporting", client=client)
    assert client.updated == []


def test_shared_table_plans_take_the_project_groups_off_unless_kept() -> None:
    step = ("Take the project's Viewer and Editor groups off test-project.agent_analytics, "
            "and Editors off test-project.agent_analytics_reporting")
    for args in (_args(service_account="bqaa-row-writer", writer_role="row-writer"), _args(reader=["group:r@example.com"])):
        assert step in _labels(args)
    assert step not in _labels(_args(reader=["group:r@example.com"], keep_project_groups=True))
    assert step not in _labels(_args(service_account="bqaa-writer"))


def test_a_token_creator_or_reader_with_a_project_role_that_reads_is_refused() -> None:
    # BigQuery data roles on the project read every table, whatever a
    # dataset's access says.
    reads = {"bindings": [{"role": "roles/bigquery.dataViewer", "members": ["group:bqaa-writers@example.com", "group:r@example.com"]}]}
    for args in (_args(service_account="bqaa-row-writer", writer_role="row-writer", token_creator=["group:bqaa-writers@example.com"]),
                 _args(reader=["group:r@example.com"])):
        with _stub_run(_FakeRun([(("projects", "get-iam-policy"), 0, json.dumps(reads))])), contextlib.redirect_stdout(io.StringIO()):
            try:
                setup._check_project_readers(args)
            except SystemExit as exc:
                assert "(roles/bigquery.dataViewer on the project test-project)" in str(exc)
            else:
                raise AssertionError("expected SystemExit")
    # Project Viewers read only through the dataset entries this setup removes,
    # so they count only when --keep-project-groups leaves those.
    viewer = {"bindings": [{"role": "roles/viewer", "members": ["group:r@example.com"]}]}
    with _stub_run(_FakeRun([(("projects", "get-iam-policy"), 0, json.dumps(viewer))])), contextlib.redirect_stdout(io.StringIO()):
        setup._check_project_readers(_args(reader=["group:r@example.com"]))
        try:
            setup._check_project_readers(_args(reader=["group:r@example.com"], keep_project_groups=True))
        except SystemExit as exc:
            assert "group:r@example.com (roles/viewer on the project test-project)" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
        setup._check_project_readers(_args(reader=["group:r@example.com"], keep_project_groups=True, allow_existing_grants=True))
    # In a whole run: refused before any Token Creator grant.
    fake = _FakeRun(_answers(reads, {}, {}))
    try:
        _row_writer_run(fake)
    except SystemExit:
        pass
    else:
        raise AssertionError("expected SystemExit")
    assert not _token_creator_calls(fake)


def test_who_reads_every_row_through_a_project_role_is_listed() -> None:
    policy = {"bindings": [{"role": "roles/owner", "members": ["user:admin@example.com"]},
                           {"role": "roles/bigquery.jobUser", "members": ["group:r@example.com"]}]}
    out = io.StringIO()
    answers = [(("projects", "get-iam-policy"), 0, json.dumps(policy)), (("identity", "check-transitive-membership"), 0, "{}")]
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(out):
        setup._check_project_readers(_args(reader=["group:r@example.com"]))
    assert "user:admin@example.com: roles/owner on the project" in out.getvalue()
    assert "OK no grant to everyone" in out.getvalue()
    assert "not a member, as Cloud Identity answers: group:r@example.com: user:admin@example.com" in out.getvalue()


def test_dataset_access_and_project_roles_are_settled_before_token_creators_and_readers() -> None:
    args = _args(service_account="bqaa-row-writer", writer_role="row-writer",
                 token_creator=["group:w@example.com"], reader=["group:r@example.com"])
    labels = _labels(args)
    groups = labels.index("Take the project's Viewer and Editor groups off test-project.agent_analytics, "
                          "and Editors off test-project.agent_analytics_reporting")
    check = labels.index("Check who reads every row, and that no reader or token creator does")
    for grant in (f"Grant token creation on {WRITER} to group:w@example.com", "Grant views dataset dataViewer to reader group:r@example.com"):
        assert check < groups < labels.index(grant)
    assert not any(label.startswith("Check who reads every row") for label in _labels(_args(service_account="bqaa-writer")))


def _role_answers(role_code: int, role_out: str, table_policy: dict | None = None):
    return [
        (("gcloud", "projects", "get-iam-policy"), 0, "{}"),
        (("bq", "show", "test-project:agent_analytics"), 0, "{}"),
        (("bq", "show", "test-project:agent_analytics_reporting"), 2, "BigQuery error in show operation: Not found: Dataset"),
        (("bq", "get-iam-policy"), 0, json.dumps(table_policy or {})),
        (("gcloud", "iam", "roles", "describe"), role_code, role_out),
    ]


def test_a_role_that_cannot_be_read_stops_the_run_before_any_token_creator() -> None:
    # Under --no-grant-iam, an unread role is not a role known to be narrow:
    # access denied, or a network error, stops the run.
    for said in ("ERROR: (gcloud.iam.roles.describe) PERMISSION_DENIED: Permission 'iam.roles.get' denied",
                 "ERROR: (gcloud.iam.roles.describe) There was a problem refreshing your current auth tokens: timed out"):
        fake = _FakeRun(_role_answers(1, said))
        try:
            _row_writer_run(fake, grant_iam=False)
        except SystemExit as exc:
            assert "Could not read projects/test-project/roles/bqaaRowWriter" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
        assert not _token_creator_calls(fake)


def test_a_missing_role_the_writer_is_bound_to_stops_the_run() -> None:
    bound = {"bindings": [{"role": "projects/test-project/roles/bqaaRowWriter", "members": [f"serviceAccount:{WRITER}"]}]}
    missing = "ERROR: (gcloud.iam.roles.describe) NOT_FOUND: The role named projects/test-project/roles/bqaaRowWriter was not found."
    fake = _FakeRun(_role_answers(1, missing, bound))
    try:
        _row_writer_run(fake, grant_iam=False)
    except SystemExit as exc:
        assert "the role cannot be found" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert not _token_creator_calls(fake)
    # No role and no binding: nothing to check, and the token creators get theirs.
    fake = _FakeRun(_role_answers(1, missing))
    _row_writer_run(fake, grant_iam=False)
    assert len(_token_creator_calls(fake)) == 1


def test_a_disabled_row_writer_role_is_refused() -> None:
    disabled = json.dumps({"stage": "DISABLED", "includedPermissions": list(setup.ROW_WRITER_PERMISSIONS)})
    for grant_iam in (True, False):
        fake = _FakeRun(_role_answers(0, disabled))
        try:
            _row_writer_run(fake, grant_iam=grant_iam)
        except SystemExit as exc:
            assert "stage DISABLED" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
        assert not _token_creator_calls(fake)


def test_a_role_missing_a_permission_is_reported_without_iam_grants() -> None:
    out = io.StringIO()
    fake = _FakeRun(_role_answers(0, json.dumps({"stage": "GA", "includedPermissions": ["bigquery.tables.updateData"]})))
    args = _args(service_account="bqaa-row-writer", writer_role="row-writer", execute=True, grant_iam=False,
                 create_dataset=False, create_table=False, token_creator=["group:bqaa-writers@example.com"],
                 keep_project_groups=True)
    with _stub_preflight(_preflight()), _stub_run(fake), contextlib.redirect_stdout(out):
        setup.run(args)
    assert "MISSING: projects/test-project/roles/bqaaRowWriter lacks bigquery.tables.get" in out.getvalue()
    assert not any(c[1:4] == ["iam", "roles", "update"] for c in fake.calls)


def test_a_token_creator_or_reader_with_a_grant_on_the_events_dataset_or_table_is_refused() -> None:
    # The tracing plugin's default setup gives each developer dataEditor on
    # the dataset; a group that keeps it reads every row.
    dataset = {"access": [{"role": "roles/bigquery.dataEditor", "groupByEmail": "BQAA-writers@example.com"}]}
    # The writer is not in that group (Cloud Identity's answer), so the
    # writer check passes and the token creators' check refuses.
    fake = _FakeRun([(("check-transitive-membership", f"--member-email={WRITER}"), 0, "{}")] + _answers({}, dataset, {}))
    try:
        _row_writer_run(fake)
    except SystemExit as exc:
        assert "group:bqaa-writers@example.com: group:BQAA-writers@example.com (roles/bigquery.dataEditor on the dataset test-project.agent_analytics)" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert not _token_creator_calls(fake)
    table = {"bindings": [{"role": "roles/bigquery.dataViewer", "members": ["group:r@example.com"]}]}
    answers = [(("gcloud", "projects", "get-iam-policy"), 0, "{}"), (("bq", "show"), 0, "{}"),
               (("bq", "get-iam-policy"), 0, json.dumps(table))]
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup._check_project_readers(_args(reader=["group:r@example.com"]))
        except SystemExit as exc:
            assert "group:r@example.com: group:r@example.com (roles/bigquery.dataViewer on the table test-project.agent_analytics.agent_events)" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
    # A service account written as userByEmail in the dataset's access is matched.
    sa_entry = {"access": [{"role": "READER", "userByEmail": "ci@test-project.iam.gserviceaccount.com"}]}
    answers = [(("gcloud", "projects", "get-iam-policy"), 0, "{}"), (("bq", "show"), 0, json.dumps(sa_entry)),
               (("bq", "get-iam-policy"), 0, "{}")]
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup._check_project_readers(_args(reader=["serviceAccount:ci@test-project.iam.gserviceaccount.com"]))
        except SystemExit:
            pass
        else:
            raise AssertionError("expected SystemExit")


def test_every_grant_on_the_events_dataset_and_table_is_listed() -> None:
    dataset = {"access": [{"role": "OWNER", "specialGroup": "projectOwners"},
                          {"role": "OWNER", "userByEmail": "admin@example.com"},
                          {"view": {"projectId": "test-project", "datasetId": "agent_analytics_reporting", "tableId": "daily_usage_by_user"}}]}
    table = {"bindings": [{"role": "projects/test-project/roles/bqaaRowWriter", "members": [f"serviceAccount:{WRITER}"]}]}
    answers = [(("gcloud", "projects", "get-iam-policy"), 0, "{}"), (("bq", "show"), 0, json.dumps(dataset)),
               (("bq", "get-iam-policy"), 0, json.dumps(table))]
    out = io.StringIO()
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(out):
        setup._check_project_readers(_args(reader=["group:r@example.com"], accept_unverified=True))
    text = out.getvalue()
    assert "specialGroup:projectOwners: OWNER on the dataset test-project.agent_analytics" in text
    assert "user:admin@example.com: OWNER on the dataset test-project.agent_analytics" in text
    # The writer's own row-writer binding reads no rows: not listed, not asked about.
    assert "bqaaRowWriter on the table" not in text
    assert "ACCEPTED (--accept-unverified), not ruled out: group:r@example.com: user:admin@example.com" in text


def test_a_missing_bigquery_client_stops_before_any_change() -> None:
    fake = _FakeRun([])
    args = _args(reader=["group:r@example.com"], execute=True, create_dataset=False, create_table=False)
    with _stub_preflight(_preflight()), _stub_run(fake), contextlib.redirect_stdout(io.StringIO()):
        setup._bigquery_client_importable = lambda: False
        try:
            setup.run(args)
        except SystemExit as exc:
            assert "google-cloud-bigquery" in str(exc) and "Nothing was changed" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
    assert fake.calls == []


def _no_grant_calls(fake: _FakeRun) -> bool:
    return not any(
        c[:2] == ["bq", "add-iam-policy-binding"] or c[1:4] in (["iam", "roles", "create"], ["iam", "roles", "update"])
        or "roles/iam.serviceAccountTokenCreator" in c or "GRANT" in " ".join(c)
        or (c[1:3] == ["projects", "add-iam-policy-binding"])
        for c in fake.calls
    )


def test_a_public_table_binding_stops_the_run_before_any_grant() -> None:
    # allAuthenticatedUsers reaches the writer too: its tokens would read rows.
    table = {"bindings": [{"role": "roles/bigquery.dataViewer", "members": ["allAuthenticatedUsers"]}]}
    fake = _FakeRun(_answers({}, {}, table))
    try:
        _row_writer_run(fake)
    except SystemExit as exc:
        assert "allAuthenticatedUsers" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert _no_grant_calls(fake)


def test_a_domain_grant_that_covers_a_reader_stops_the_run_before_any_grant() -> None:
    dataset = {"access": [{"role": "READER", "domain": "example.com"}]}
    fake = _FakeRun(_answers({}, dataset, {}))
    args = _args(service_account="bqaa-row-writer", writer_role="row-writer", execute=True, create_dataset=False,
                 create_table=False, reader=["user:alice@example.com"], keep_project_groups=True)
    with _stub_preflight(_preflight()), _stub_run(fake), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup.run(args)
        except SystemExit as exc:
            assert "user:alice@example.com: domain:example.com (READER on the dataset test-project.agent_analytics)" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
    assert _no_grant_calls(fake)


def test_a_public_project_binding_or_dataset_entry_stops_the_run() -> None:
    public_project = {"bindings": [{"role": "roles/bigquery.dataViewer", "members": ["allUsers"]}]}
    answers = [(("gcloud", "projects", "get-iam-policy"), 0, json.dumps(public_project)), (("bq", "show"), 0, "{}"),
               (("bq", "get-iam-policy"), 0, "{}")]
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup._check_project_readers(_args(service_account="bqaa-row-writer", writer_role="row-writer"))
        except SystemExit as exc:
            assert "everyone can read the table: allUsers" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
    # A public dataset entry the dataset-access step takes off is left to it;
    # kept (--keep-project-groups), it stops the run.
    public_dataset = {"access": [{"role": "READER", "iamMember": "allAuthenticatedUsers"}]}
    answers = [(("gcloud", "projects", "get-iam-policy"), 0, "{}"), (("bq", "show"), 0, json.dumps(public_dataset)),
               (("bq", "get-iam-policy"), 0, "{}")]
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
        setup._check_project_readers(_args(reader=["group:r@example.com"]))
        try:
            setup._check_project_readers(_args(reader=["group:r@example.com"], keep_project_groups=True))
        except SystemExit as exc:
            assert "everyone can read the table" in str(exc)
        else:
            raise AssertionError("expected SystemExit")


def test_a_group_grant_a_reader_may_be_in_needs_the_override() -> None:
    dataset = {"access": [{"role": "READER", "groupByEmail": "all-staff@example.com"}]}
    answers = [(("gcloud", "projects", "get-iam-policy"), 0, "{}"), (("bq", "show"), 0, json.dumps(dataset)),
               (("bq", "get-iam-policy"), 0, "{}"),
               (("identity", "check-transitive-membership"), 1, "ERROR: (gcloud.identity.groups.memberships.check-transitive-membership) PERMISSION_DENIED")]
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup._check_project_readers(_args(reader=["user:alice@example.com"]))
        except SystemExit as exc:
            assert "could not rule out" in str(exc) and "user:alice@example.com: group:all-staff@example.com" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
        setup._check_project_readers(_args(reader=["user:alice@example.com"], accept_unverified=True))
        # With no reader or token creator, there is no one to be a member.
        setup._check_project_readers(_args(service_account="bqaa-row-writer", writer_role="row-writer"))
    # Cloud Identity's answer settles it: a member reads every row; one who is not passes.
    for answer, stops in (('{"hasMembership": true}', True), ("{}", False)):
        answers[-1] = (("identity", "check-transitive-membership"), 0, answer)
        fake = _FakeRun(answers)
        with _stub_run(fake), contextlib.redirect_stdout(io.StringIO()):
            try:
                setup._check_project_readers(_args(reader=["user:alice@example.com"]))
            except SystemExit as exc:
                assert stops and "a member, as Cloud Identity answers" in str(exc)
            else:
                assert not stops
        asked = [c for c in fake.calls if "check-transitive-membership" in c]
        assert asked and "--group-email=all-staff@example.com" in asked[0] and "--member-email=alice@example.com" in asked[0]


def test_a_grant_to_the_writers_domain_counts_against_the_writer() -> None:
    dataset = {"access": [{"role": "WRITER", "domain": "test-project.iam.gserviceaccount.com"}]}
    fake = _FakeRun(_answers({}, dataset, {}))
    try:
        _row_writer_run(fake)
    except SystemExit as exc:
        assert "granted to domain:test-project.iam.gserviceaccount.com" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert _no_grant_calls(fake)


def test_the_reader_check_runs_before_any_change() -> None:
    args = _args(service_account="bqaa-row-writer", writer_role="row-writer",
                 token_creator=["group:w@example.com"], reader=["group:r@example.com"])
    labels = _labels(args)
    check = labels.index("Check who reads every row, and that no reader or token creator does")
    writer = labels.index(f"Check that serviceAccount:{WRITER} holds nothing beyond the row-writer role")
    first_change = min(labels.index("Ensure role projects/test-project/roles/bqaaRowWriter (bigquery.tables.get, bigquery.tables.updateData)"),
                       labels.index("Take the project's Viewer and Editor groups off test-project.agent_analytics, "
                                    "and Editors off test-project.agent_analytics_reporting"))
    assert writer < check < first_change
    # Readers alone: still before the dataset-access step and the grants.
    labels = _labels(_args(reader=["group:r@example.com"]))
    assert labels.index("Check who reads every row, and that no reader or token creator does") < labels.index(
        "Take the project's Viewer and Editor groups off test-project.agent_analytics, and Editors off test-project.agent_analytics_reporting")


def test_the_writer_check_itself_refuses_a_public_or_domain_grant() -> None:
    # The writer check stands on its own: everyone's grant reaches the writer.
    for table in ({"bindings": [{"role": "roles/bigquery.dataViewer", "members": ["allUsers"]}]},
                  {"bindings": [{"role": "roles/bigquery.dataEditor", "members": ["domain:test-project.iam.gserviceaccount.com"]}]}):
        answers = [(("gcloud", "projects", "get-iam-policy"), 0, "{}"), (("bq", "show"), 0, "{}"),
                   (("bq", "get-iam-policy"), 0, json.dumps(table))]
        args = _args(service_account="bqaa-row-writer", writer_role="row-writer", principal=f"serviceAccount:{WRITER}")
        with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
            try:
                setup._check_writer_grants(args)
            except SystemExit as exc:
                assert "already holds more than the row-writer role" in str(exc)
            else:
                raise AssertionError("expected SystemExit")
    # Everyone's project role that reads nothing (a viewer of billing, say) is not the writer's.
    harmless = {"bindings": [{"role": "roles/billing.viewer", "members": ["allAuthenticatedUsers"]}]}
    answers = [(("gcloud", "projects", "get-iam-policy"), 0, json.dumps(harmless)), (("bq", "show"), 0, "{}"),
               (("bq", "get-iam-policy"), 0, "{}")]
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
        setup._check_writer_grants(_args(service_account="bqaa-row-writer", writer_role="row-writer", principal=f"serviceAccount:{WRITER}"))


GROUPS = dict(token_creator=["group:bqaa-writers@example.com"], reader=["group:bqaa-readers@example.com"])



def test_a_persons_grant_with_group_readers_needs_cloud_identity_or_the_override() -> None:
    # The guide's setup: groups for the token creators and the readers. A
    # developer kept WRITER on the events dataset (the dataEditor move), or
    # dataViewer on the table: either may be in a group.
    for dataset, table in (({"access": [{"role": "WRITER", "userByEmail": "dev7@example.com"}]}, {}),
                           ({}, {"bindings": [{"role": "roles/bigquery.dataViewer", "members": ["user:dev7@example.com"]}]})):
        fake = _FakeRun([(("identity", "check-transitive-membership"), 1, "ERROR: PERMISSION_DENIED")] + _answers({}, dataset, table))
        try:
            _row_writer_run(fake, **GROUPS)
        except SystemExit as exc:
            assert "could not rule out" in str(exc)
            assert "group:bqaa-writers@example.com: user:dev7@example.com" in str(exc)
            assert "group:bqaa-readers@example.com: user:dev7@example.com" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
        assert _no_grant_calls(fake)
    dataset = {"access": [{"role": "WRITER", "userByEmail": "dev7@example.com"}]}
    # In a group, as Cloud Identity answers: stops, named a member.
    fake = _FakeRun([(("identity", "check-transitive-membership", "--group-email=bqaa-writers@example.com"), 0, '{"hasMembership": true}')]
                    + _answers({}, dataset, {}))
    try:
        _row_writer_run(fake, **GROUPS)
    except SystemExit as exc:
        assert "group:bqaa-writers@example.com: user:dev7@example.com (WRITER on the dataset test-project.agent_analytics) (a member, as Cloud Identity answers)" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert _no_grant_calls(fake)
    # In neither group: the run goes on, and says what was checked.
    out = io.StringIO()
    fake = _FakeRun([(("identity", "check-transitive-membership"), 0, "{}")] + _answers({}, dataset, {}))
    args = _args(service_account="bqaa-row-writer", writer_role="row-writer", execute=True, create_dataset=False,
                 create_table=False, keep_project_groups=True, **GROUPS)
    with _stub_preflight(_preflight()), _stub_run(fake), contextlib.redirect_stdout(out), _views_left_alone():
        setup.run(args)
    ok = next(line for line in out.getvalue().splitlines() if line.startswith("OK no grant to everyone"))
    assert "not a member, as Cloud Identity answers: " in ok
    assert "group:bqaa-readers@example.com: user:dev7@example.com (WRITER on the dataset test-project.agent_analytics)" in ok
    assert "group:bqaa-writers@example.com: user:dev7@example.com (WRITER on the dataset test-project.agent_analytics)" in ok
    assert _token_creator_calls(fake)
    # Unanswered, the override keeps it.
    fake = _FakeRun([(("identity", "check-transitive-membership"), 1, "ERROR: PERMISSION_DENIED")] + _answers({}, dataset, {}))
    _row_writer_run(fake, accept_unverified=True, **GROUPS)
    assert _token_creator_calls(fake)


def test_a_group_grant_and_a_group_member_need_more_than_a_no() -> None:
    # The member group is not inside the granted group, but some of its
    # members may be: that cannot be ruled out.
    dataset = {"access": [{"role": "READER", "groupByEmail": "all-staff@example.com"}]}
    answers = [(("gcloud", "projects", "get-iam-policy"), 0, "{}"), (("bq", "show"), 0, json.dumps(dataset)),
               (("bq", "get-iam-policy"), 0, "{}"), (("identity", "check-transitive-membership"), 0, "{}")]
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup._check_project_readers(_args(reader=["group:bqaa-readers@example.com"]))
        except SystemExit as exc:
            assert "could not rule out" in str(exc) and "group:bqaa-readers@example.com: group:all-staff@example.com" in str(exc)
        else:
            raise AssertionError("expected SystemExit")
    # Inside it as a whole: every reader reads every row.
    answers[-1] = (("identity", "check-transitive-membership"), 0, '{"hasMembership": true}')
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup._check_project_readers(_args(reader=["group:bqaa-readers@example.com"]))
        except SystemExit as exc:
            assert "can read every row" in str(exc) and "(a member, as Cloud Identity answers)" in str(exc)
        else:
            raise AssertionError("expected SystemExit")


def test_a_domain_grant_and_a_group_member_need_the_override() -> None:
    # A group's own address says nothing of its members' domains.
    dataset = {"access": [{"role": "READER", "domain": "example.com"}]}
    fake = _FakeRun(_answers({}, dataset, {}))
    try:
        _row_writer_run(fake, token_creator=["group:bqaa-writers@groups.example.com"])
    except SystemExit as exc:
        assert "could not rule out" in str(exc)
        assert "group:bqaa-writers@groups.example.com: domain:example.com (READER on the dataset test-project.agent_analytics)" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert _no_grant_calls(fake)
    # Nor does a group in the same domain: its members may be from anywhere.
    with _stub_run(_FakeRun(_answers({}, dataset, {}))), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup._check_project_readers(_args(reader=["group:readers@example.com"]))
        except SystemExit as exc:
            assert "could not rule out" in str(exc)
        else:
            raise AssertionError("expected SystemExit")


def test_a_domain_grant_and_a_person_in_another_domain_need_the_override() -> None:
    # example.org may be a secondary domain of example.com's identity
    # customer: the address alone cannot tell.
    table = {"bindings": [{"role": "roles/bigquery.dataViewer", "members": ["domain:example.com"]}]}
    fake = _FakeRun(_answers({}, {}, table))
    try:
        _row_writer_run(fake, token_creator=["user:alice@example.org"], reader=["user:alice@example.org"])
    except SystemExit as exc:
        assert "could not rule out" in str(exc)
        assert "user:alice@example.org: domain:example.com (roles/bigquery.dataViewer on the table test-project.agent_analytics.agent_events)" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert _no_grant_calls(fake)
    # A service account belongs to no domain but its own address's.
    answers = [(("gcloud", "projects", "get-iam-policy"), 0, "{}"), (("bq", "show"), 0, "{}"),
               (("bq", "get-iam-policy"), 0, json.dumps(table))]
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
        setup._check_project_readers(_args(reader=["serviceAccount:ci@test-project.iam.gserviceaccount.com"]))


def test_a_custom_project_role_that_reads_is_found() -> None:
    raw = json.dumps({"includedPermissions": ["bigquery.tables.get", "bigquery.tables.getData"]})
    exports = json.dumps({"includedPermissions": ["bigquery.tables.export", "bigquery.jobs.create"]})
    narrow = json.dumps({"includedPermissions": ["bigquery.jobs.create"]})
    cases = (
        ("projects/test-project/roles/rawReader", ("describe", "rawReader", "--project", "test-project"), raw),
        ("organizations/123/roles/orgReader", ("describe", "orgReader", "--organization", "123"), exports),
        ("roles/somevendor.dataReader", ("describe", "roles/somevendor.dataReader"), raw),
    )
    for role, words, answer in cases:
        policy = {"bindings": [{"role": role, "members": ["user:alice@example.com"]}]}
        fake = _FakeRun([(words, 0, answer)] + _answers(policy, {}, {}))
        try:
            _row_writer_run(fake, token_creator=["user:alice@example.com"], reader=["user:alice@example.com"])
        except SystemExit as exc:
            assert f"user:alice@example.com: user:alice@example.com ({role} on the project test-project)" in str(exc)
        else:
            raise AssertionError(f"expected SystemExit for {role}")
        assert _no_grant_calls(fake)
        assert any(all(w in c for w in words) for c in fake.calls), role
    # A custom role that reads nothing is not a grant on the table.
    policy = {"bindings": [{"role": "projects/test-project/roles/jobsOnly", "members": ["user:alice@example.com"]}]}
    fake = _FakeRun([(("describe", "jobsOnly", "--project", "test-project"), 0, narrow)] + _answers(policy, {}, {}))
    _row_writer_run(fake, token_creator=["user:alice@example.com"], reader=["user:alice@example.com"])
    assert _token_creator_calls(fake)
    # One whose permissions cannot be read needs the override.
    fake = _FakeRun([(("describe", "jobsOnly"), 1, "ERROR: PERMISSION_DENIED: iam.roles.get")] + _answers(policy, {}, {}))
    try:
        _row_writer_run(fake, token_creator=["user:alice@example.com"], reader=["user:alice@example.com"])
    except SystemExit as exc:
        assert "could not rule out" in str(exc) and "a role whose permissions could not be read" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert _no_grant_calls(fake)
    # Granted to everyone, a role that cannot be read stops the check with no reader at all.
    public = {"bindings": [{"role": "projects/test-project/roles/jobsOnly", "members": ["allUsers"]}]}
    answers = [(("describe", "jobsOnly"), 1, "ERROR: PERMISSION_DENIED"), (("gcloud", "projects", "get-iam-policy"), 0, json.dumps(public)),
               (("bq", "show"), 0, "{}"), (("bq", "get-iam-policy"), 0, "{}")]
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup._check_project_readers(_args(service_account="bqaa-row-writer", writer_role="row-writer"))
        except SystemExit as exc:
            assert "could not rule out" in str(exc) and "allUsers (projects/test-project/roles/jobsOnly on the project" in str(exc)
        else:
            raise AssertionError("expected SystemExit")


def test_the_writer_check_reads_a_broad_grants_custom_role() -> None:
    args = _args(service_account="bqaa-row-writer", writer_role="row-writer", principal=f"serviceAccount:{WRITER}")
    raw = json.dumps({"includedPermissions": ["bigquery.tables.getData"]})
    narrow = json.dumps({"includedPermissions": ["resourcemanager.projects.get"]})
    policy = {"bindings": [{"role": "projects/test-project/roles/rawReader", "members": ["allAuthenticatedUsers"]}]}
    for code, answer, stops in ((0, raw, True), (1, "ERROR: PERMISSION_DENIED", True), (0, narrow, False)):
        answers = [(("describe", "rawReader"), code, answer), (("gcloud", "projects", "get-iam-policy"), 0, json.dumps(policy)),
                   (("bq", "show"), 0, "{}"), (("bq", "get-iam-policy"), 0, "{}")]
        with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
            try:
                setup._check_writer_grants(args)
            except SystemExit as exc:
                assert stops and "projects/test-project/roles/rawReader on the project test-project" in str(exc)
                if code:
                    assert "a role whose permissions could not be read" in str(exc)
            else:
                assert not stops


def test_domain_members_are_refused_for_readers_and_token_creators() -> None:
    for extra in (dict(reader=["domain:example.com"]),
                  dict(service_account="bqaa-row-writer", writer_role="row-writer", token_creator=["domain:example.com"])):
        try:
            setup._require_project_dataset(_args(**extra))
        except SystemExit as exc:
            assert "Not a domain" in str(exc)
        else:
            raise AssertionError(f"expected SystemExit for {extra}")


def test_a_group_grant_the_writer_may_be_in() -> None:
    # A reading group holds project dataViewer; Alice, the token creator, is
    # not in it, but the writer may be: impersonating it would read every row.
    policy = {"bindings": [{"role": "roles/bigquery.dataViewer", "members": ["group:raw-readers@example.com"]}]}
    alice_out = (("check-transitive-membership", "--member-email=alice@example.com"), 0, "{}")
    writer_in = (("check-transitive-membership", f"--member-email={WRITER}"), 0, '{"hasMembership": true}')
    fake = _FakeRun([alice_out, writer_in] + _answers(policy, {}, {}))
    try:
        _row_writer_run(fake, token_creator=["user:alice@example.com"], keep_project_groups=False)
    except SystemExit as exc:
        assert "already holds more than the row-writer role" in str(exc)
        assert "(granted to group:raw-readers@example.com) (the writer is a member, as Cloud Identity answers)" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert _no_grant_calls(fake)
    asked = [c for c in fake.calls if "check-transitive-membership" in c and f"--member-email={WRITER}" in c]
    assert asked and "--group-email=raw-readers@example.com" in asked[0]
    # Unanswered for the writer: not ruled out, so it stops too, unless accepted.
    fake = _FakeRun([alice_out] + _answers(policy, {}, {}))
    try:
        _row_writer_run(fake, token_creator=["user:alice@example.com"], keep_project_groups=False)
    except SystemExit as exc:
        assert "could not rule out" in str(exc) and "granted to group:raw-readers@example.com" in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert _no_grant_calls(fake)
    fake = _FakeRun([alice_out] + _answers(policy, {}, {}))
    _row_writer_run(fake, token_creator=["user:alice@example.com"], keep_project_groups=False, accept_unverified=True)
    assert _token_creator_calls(fake)
    # Neither Alice nor the writer in it: the run goes on.
    writer_out = (("check-transitive-membership", f"--member-email={WRITER}"), 0, "{}")
    fake = _FakeRun([alice_out, writer_out] + _answers(policy, {}, {}))
    _row_writer_run(fake, token_creator=["user:alice@example.com"], keep_project_groups=False)
    assert _token_creator_calls(fake)


def test_the_guides_setup_where_cloud_identity_answers_403() -> None:
    # The two-group command in a project whose Owner made the dataset
    # (BigQuery's OWNER entry for its creator), on an account whose Cloud
    # Identity answers 403 to every membership question.
    owner = {"bindings": [{"role": "roles/owner", "members": ["user:admin@example.com"]}]}
    dataset = {"access": [{"role": "OWNER", "userByEmail": "admin@example.com"},
                          {"role": "OWNER", "specialGroup": "projectOwners"}]}
    fake = _FakeRun(_answers(owner, dataset, {}))
    try:
        _row_writer_run(fake, keep_project_groups=False, **GROUPS)
    except SystemExit as exc:
        assert "could not rule out" in str(exc) and "user:admin@example.com" in str(exc)
        assert "--allow-existing-grants keeps" not in str(exc)
    else:
        raise AssertionError("expected SystemExit")
    assert _no_grant_calls(fake)
    # Checked and accepted: the first run completes.
    fake = _FakeRun(_answers(owner, dataset, {}))
    _row_writer_run(fake, keep_project_groups=False, accept_unverified=True, **GROUPS)
    assert _token_creator_calls(fake)
    # The rerun, with the writer's bqaaRowWriter binding on the table: the
    # same acceptance holds, and nobody is asked about the writer's binding.
    bound = {"bindings": [{"role": "projects/test-project/roles/bqaaRowWriter", "members": [f"serviceAccount:{WRITER}"]}]}
    fake = _FakeRun(_answers(owner, dataset, bound))
    _row_writer_run(fake, keep_project_groups=False, accept_unverified=True, **GROUPS)
    assert _token_creator_calls(fake)
    assert not [c for c in fake.calls if "check-transitive-membership" in c and f"--member-email={WRITER}" in c]


def test_accepting_the_unverified_keeps_the_definite_refusals() -> None:
    cases = (
        # The writer holds WRITER on the events dataset (round 1's case).
        ({}, {"access": [{"role": "WRITER", "userByEmail": WRITER}]}, {}),
        # Everyone reads the table.
        ({}, {}, {"bindings": [{"role": "roles/bigquery.dataViewer", "members": ["allAuthenticatedUsers"]}]}),
        # The readers' group itself reads every table through a project role.
        ({"bindings": [{"role": "roles/bigquery.dataViewer", "members": ["group:bqaa-readers@example.com"]}]}, {}, {}),
    )
    for project_policy, dataset, table in cases:
        fake = _FakeRun(_answers(project_policy, dataset, table))
        try:
            _row_writer_run(fake, accept_unverified=True, **GROUPS)
        except SystemExit as exc:
            assert "--allow-existing-grants keeps them" in str(exc)
        else:
            raise AssertionError(f"expected SystemExit for {project_policy, dataset, table}")
        assert _no_grant_calls(fake)
    # And --allow-existing-grants alone accepts nothing that was not ruled out.
    dataset = {"access": [{"role": "READER", "groupByEmail": "all-staff@example.com"}]}
    answers = [(("gcloud", "projects", "get-iam-policy"), 0, "{}"), (("bq", "show"), 0, json.dumps(dataset)),
               (("bq", "get-iam-policy"), 0, "{}")]
    with _stub_run(_FakeRun(answers)), contextlib.redirect_stdout(io.StringIO()):
        try:
            setup._check_project_readers(_args(reader=["user:alice@example.com"], allow_existing_grants=True))
        except SystemExit as exc:
            assert "could not rule out" in str(exc) and "--accept-unverified" in str(exc)
        else:
            raise AssertionError("expected SystemExit")


def test_an_inherited_project_role_beyond_the_writers_access_is_refused() -> None:
    # A role the writer gets through a group, everyone or a domain counts
    # when it does more than insert rows: deleting tables, running queries,
    # changing IAM. Alice, the token creator, is outside the group.
    janitor = json.dumps({"includedPermissions": ["bigquery.tables.delete", "bigquery.tables.get"]})
    job_user = json.dumps({"includedPermissions": ["bigquery.jobs.create", "resourcemanager.projects.get"]})
    iam_admin = json.dumps({"includedPermissions": ["resourcemanager.projects.setIamPolicy"]})
    logs = json.dumps({"includedPermissions": ["logging.logEntries.list"]})
    alice_out = (("check-transitive-membership", "--member-email=alice@example.com"), 0, "{}")
    writer_in = (("check-transitive-membership", f"--member-email={WRITER}"), 0, '{"hasMembership": true}')
    cases = (
        ("projects/test-project/roles/tableJanitor", ("describe", "tableJanitor"), janitor),
        ("roles/bigquery.jobUser", ("describe", "roles/bigquery.jobUser"), job_user),
        ("projects/test-project/roles/iamAdmin", ("describe", "iamAdmin"), iam_admin),
    )
    for role, words, answer in cases:
        policy = {"bindings": [{"role": role, "members": ["group:maintenance@example.com"]}]}
        # The writer in the group, as Cloud Identity answers: known extra access.
        fake = _FakeRun([(words, 0, answer), alice_out, writer_in] + _answers(policy, {}, {}))
        try:
            _row_writer_run(fake, token_creator=["user:alice@example.com"], accept_unverified=True)
        except SystemExit as exc:
            assert f"{role} on the project test-project (granted to group:maintenance@example.com) (the writer is a member" in str(exc)
        else:
            raise AssertionError(f"expected SystemExit for {role}")
        assert _no_grant_calls(fake)
        # Unanswered: not ruled out.
        fake = _FakeRun([(words, 0, answer), alice_out] + _answers(policy, {}, {}))
        try:
            _row_writer_run(fake, token_creator=["user:alice@example.com"])
        except SystemExit as exc:
            assert "could not rule out" in str(exc) and f"{role} on the project test-project" in str(exc)
        else:
            raise AssertionError(f"expected SystemExit for {role}, unanswered")
        assert _no_grant_calls(fake)
    # Granted to everyone, jobUser lets the writer run queries.
    public = {"bindings": [{"role": "roles/bigquery.jobUser", "members": ["allAuthenticatedUsers"]}]}
    fake = _FakeRun([(("describe", "roles/bigquery.jobUser"), 0, job_user)] + _answers(public, {}, {}))
    try:
        _row_writer_run(fake)
    except SystemExit as exc:
        assert "roles/bigquery.jobUser on the project test-project (granted to allAuthenticatedUsers)" in str(exc)
    else:
        raise AssertionError("expected SystemExit for everyone's jobUser")
    assert _no_grant_calls(fake)
    # A role with nothing of BigQuery's or IAM's, through the same group, is not the writer's concern.
    policy = {"bindings": [{"role": "projects/test-project/roles/logReader", "members": ["group:maintenance@example.com"]}]}
    fake = _FakeRun([(("describe", "logReader"), 0, logs), alice_out, writer_in] + _answers(policy, {}, {}))
    _row_writer_run(fake, token_creator=["user:alice@example.com"])
    assert _token_creator_calls(fake)


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
        test_token_creators_need_the_row_writer_role,
        test_a_principal_other_than_the_service_account_is_refused,
        test_without_iam_grants_the_writer_and_its_role_are_still_checked_before_token_creators,
        test_a_views_dataset_that_is_the_events_dataset_is_refused_before_any_call,
        test_only_the_mods_views_are_authorized,
        test_the_project_groups_come_off_the_datasets,
        test_shared_table_plans_take_the_project_groups_off_unless_kept,
        test_a_token_creator_or_reader_with_a_project_role_that_reads_is_refused,
        test_who_reads_every_row_through_a_project_role_is_listed,
        test_dataset_access_and_project_roles_are_settled_before_token_creators_and_readers,
        test_a_role_that_cannot_be_read_stops_the_run_before_any_token_creator,
        test_a_missing_role_the_writer_is_bound_to_stops_the_run,
        test_a_disabled_row_writer_role_is_refused,
        test_a_role_missing_a_permission_is_reported_without_iam_grants,
        test_a_token_creator_or_reader_with_a_grant_on_the_events_dataset_or_table_is_refused,
        test_every_grant_on_the_events_dataset_and_table_is_listed,
        test_a_missing_bigquery_client_stops_before_any_change,
        test_a_public_table_binding_stops_the_run_before_any_grant,
        test_a_domain_grant_that_covers_a_reader_stops_the_run_before_any_grant,
        test_a_public_project_binding_or_dataset_entry_stops_the_run,
        test_a_group_grant_a_reader_may_be_in_needs_the_override,
        test_a_grant_to_the_writers_domain_counts_against_the_writer,
        test_the_reader_check_runs_before_any_change,
        test_the_writer_check_itself_refuses_a_public_or_domain_grant,
        test_a_persons_grant_with_group_readers_needs_cloud_identity_or_the_override,
        test_a_group_grant_and_a_group_member_need_more_than_a_no,
        test_a_domain_grant_and_a_group_member_need_the_override,
        test_a_domain_grant_and_a_person_in_another_domain_need_the_override,
        test_a_custom_project_role_that_reads_is_found,
        test_the_writer_check_reads_a_broad_grants_custom_role,
        test_domain_members_are_refused_for_readers_and_token_creators,
        test_a_group_grant_the_writer_may_be_in,
        test_the_guides_setup_where_cloud_identity_answers_403,
        test_accepting_the_unverified_keeps_the_definite_refusals,
        test_an_inherited_project_role_beyond_the_writers_access_is_refused,
    ):
        test()
    print("setup_gcp_prereqs tests passed")
