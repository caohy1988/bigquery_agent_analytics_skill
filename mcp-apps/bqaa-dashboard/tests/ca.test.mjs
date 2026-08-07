// CA bridge unit tests: response parsing and exact scope literals (#18-r5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMessages, sqlStringLiteral } from "../src/ca.js";

test("sqlStringLiteral preserves exact values with quotes/newlines/backslashes", () => {
  assert.equal(sqlStringLiteral("billing-agent"), "'billing-agent'");
  assert.equal(sqlStringLiteral("O'Brien's agent"), "'O\\'Brien\\'s agent'");
  assert.equal(sqlStringLiteral("a\\b"), "'a\\\\b'");
  assert.equal(sqlStringLiteral("line1\nline2"), "'line1\\nline2'");
});

test("parseMessages folds the CA stream into one result", () => {
  const stream = [
    { systemMessage: { text: { parts: ["Analyzing context"], textType: "THOUGHT" } } },
    { systemMessage: { data: { generatedSql: "SELECT tool, COUNT(*) FROM t GROUP BY tool" } } },
    {
      systemMessage: {
        data: {
          result: {
            schema: { fields: [{ name: "tool" }, { name: "n" }] },
            data: [{ tool: "fetch_invoice", n: 196 }],
          },
        },
      },
    },
    { systemMessage: { text: { parts: ["**fetch_invoice** fails most."], textType: "FINAL_RESPONSE" } } },
    { systemMessage: { text: { parts: ["What about latency?"], textType: "FOLLOWUP_QUESTIONS" } } },
  ];
  const r = parseMessages("Which tool fails most?", stream);
  assert.match(r.answer, /fetch_invoice/);
  assert.equal(r.steps.length, 1);
  assert.match(r.sql, /GROUP BY tool/);
  assert.deepEqual(r.schema, ["tool", "n"]);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.followups, ["What about latency?"]);
});

// ---- sixth-review: scope contract and pre-abort semantics

import { askConversational, buildScopeInstruction } from "../src/ca.js";

test("the Ask scope instruction is mandatory, not advisory (#4-r6)", () => {
  const scope = { startIso: "2026-08-05T00:00:00Z", endIso: "2026-08-06T00:00:00Z", agent: "billing-agent" };
  const instruction = buildScopeInstruction(scope);
  assert.match(instruction, /MANDATORY/);
  assert.match(instruction, /MUST include/);
  assert.ok(!/unless the user explicitly asks otherwise/.test(instruction), "scope must not be overridable");
  assert.match(instruction, /answer within this scope/);
  assert.match(instruction, /'billing-agent'/);
  assert.equal(buildScopeInstruction(undefined), "");
});

test("a pre-aborted Ask rejects synchronously, before credentials (#8-r6)", async () => {
  const ac = new AbortController();
  ac.abort();
  const started = Date.now();
  await assert.rejects(
    () =>
      askConversational(
        { project: "p", dataset: "d", table: "t" },
        "Which tool fails most?",
        [],
        ac.signal,
      ),
    /aborted before start/,
  );
  assert.ok(Date.now() - started < 200, "pre-aborted Ask must fail fast, not acquire credentials");
});

// ---- seventh-review: scope verification is earned, never assumed

import { verifyScope, withScope } from "../src/ca.js";

test("verifyScope confirms predicates in generated SQL or reports false (#3-r7)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z", agent: "billing-agent" };
  const good = "SELECT 1 FROM t WHERE timestamp BETWEEN '2026-08-06T00:00:00Z' AND '2026-08-07T00:00:00Z' AND agent = 'billing-agent'";
  assert.equal(verifyScope(good, scope), true);
  assert.equal(verifyScope("SELECT COUNT(*) FROM t", scope), false, "unscoped SQL must not verify");
  assert.equal(verifyScope(null, scope), false, "missing SQL cannot verify");
  assert.equal(verifyScope(good.replace("billing-agent", "other"), scope), false, "wrong agent must not verify");
  assert.equal(verifyScope(null, undefined), true, "no scope → nothing to verify");
});

test("withScope reports verified truthfully and annotates unverified answers (#3-r7)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z" };
  const base = { question: "q", answer: "42", steps: [], sql: "SELECT 1", schema: [], rows: [], followups: [] };
  const unverified = withScope(base, scope);
  assert.equal(unverified.scope?.verified, false);
  assert.match(unverified.answer, /Scope not verified/);
  const verified = withScope(
    { ...base, sql: `SELECT 1 FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'` },
    scope,
  );
  assert.equal(verified.scope?.verified, true);
  assert.ok(!/Scope not verified/.test(verified.answer));
});
