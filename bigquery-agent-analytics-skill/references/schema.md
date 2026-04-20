# Schema Reference

Single event-sourced table: `{PROJECT}.{DATASET}.{TABLE}`

## Columns

| Column         | Type            | Notes                                                         |
|----------------|-----------------|---------------------------------------------------------------|
| timestamp      | TIMESTAMP       | UTC, microsecond precision. Table is partitioned on this.     |
| event_type     | STRING          | See event types below                                         |
| agent          | STRING          | Agent name responsible for the event                          |
| session_id     | STRING          | Persistent conversation thread identifier                     |
| invocation_id  | STRING          | Single execution turn within a session                        |
| user_id        | STRING          | User who initiated the session                                |
| trace_id       | STRING          | OpenTelemetry Trace ID (32-char hex)                          |
| span_id        | STRING          | OpenTelemetry Span ID (16-char hex)                           |
| parent_span_id | STRING          | Caller's span — used for delegation tree self-joins           |
| content        | JSON            | **Polymorphic** — structure depends on event_type             |
| content_parts  | REPEATED RECORD | Multimodal segments (see nested structure below)              |
| attributes     | JSON            | Model info, token usage, session metadata, custom tags        |
| latency_ms     | JSON            | `$.total_ms`, `$.time_to_first_token_ms`                      |
| status         | STRING          | `OK` or `ERROR`                                               |
| error_message  | STRING          | Exception details when status = ERROR                         |
| is_truncated   | BOOLEAN         | True if content exceeded cell size limit                      |

## Event types

`LLM_REQUEST`, `LLM_RESPONSE`, `TOOL_STARTING`, `TOOL_COMPLETED`,
`HITL_CREDENTIAL_REQUEST`, `HITL_CREDENTIAL_REQUEST_COMPLETED`,
`HITL_CONFIRMATION_REQUEST`, `HITL_CONFIRMATION_REQUEST_COMPLETED`,
`HITL_INPUT_REQUEST`, `HITL_INPUT_REQUEST_COMPLETED`, `STATE_DELTA`

Every `HITL_*_REQUEST` has a matching `HITL_*_REQUEST_COMPLETED`
event when the user responds. Analyses that count unanswered
requests must join on all three completion types — omitting
`HITL_CONFIRMATION_REQUEST_COMPLETED` will misreport every
confirmation as never-completed.

## Content field by event_type

| event_type     | content paths                                                 |
|----------------|---------------------------------------------------------------|
| LLM_REQUEST    | `$.system_prompt`, `$.prompt[]` (array of {role, content})    |
| LLM_RESPONSE   | `$.response` (text)                                           |
| TOOL_STARTING  | `$.tool` (name), `$.args` (object), `$.tool_origin`           |
| TOOL_COMPLETED | `$.tool` (name), `$.result`, `$.tool_origin`                  |
| HITL_*         | Credential/input/confirmation payloads                        |
| STATE_DELTA    | State changes in `attributes.state_delta`                     |

## Attributes field paths

- `$.model` — model identifier (e.g., "gemini-2.0-flash")
- `$.usage_metadata.prompt_tokens` — input token count (INT64)
- `$.usage_metadata.completion_tokens` — output token count (INT64)
- `$.usage_metadata.total_tokens` — total token count (INT64)
- `$.session_metadata` — session-level metadata
- `$.custom_tags` — user-defined tags

## content_parts nested structure

```
content_parts[]:
  mime_type        STRING
  uri              STRING
  object_ref:
    uri            STRING
    version        STRING
    authorizer     STRING
    details        JSON
  text             STRING
  part_index       INT64
  part_attributes  STRING
  storage_mode     STRING
```
