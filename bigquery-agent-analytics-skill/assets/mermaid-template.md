# Mermaid Template for Agent Delegation

When rendering agent delegation results, use this `sequenceDiagram` template.
Replace participant names and messages with actual query results.

```mermaid
sequenceDiagram
    participant User
    participant ParentAgent
    participant ChildAgentA
    participant ChildAgentB

    User->>ParentAgent: user query
    ParentAgent->>ChildAgentA: delegate (N calls)
    ChildAgentA-->>ParentAgent: results
    ParentAgent->>ChildAgentB: delegate (M calls)
    ChildAgentB-->>ParentAgent: results
    ParentAgent-->>User: final response
```

## Rules

- Use `-->>` (dashed) for return arrows
- Include call counts from query results in the message labels
- If a delegation loop is detected (A->B->A), add a note:

```mermaid
sequenceDiagram
    participant AgentA
    participant AgentB

    AgentA->>AgentB: delegate
    AgentB->>AgentA: delegate back (LOOP DETECTED)

    Note over AgentA,AgentB: Delegation loop — investigate
```
