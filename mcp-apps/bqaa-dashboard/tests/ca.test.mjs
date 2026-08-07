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
