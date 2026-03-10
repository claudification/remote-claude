# Terminal Routing Flow

## Identity Model

```
wrapperId = physical identity (this machine, this process, this PTY)
sessionId = logical identity (Claude Code session, can be shared via --continue)
```

Multiple wrappers can share a sessionId. Each wrapper has exactly one PTY.
A session only ends when its LAST wrapper disconnects.

## Data Flow

```mermaid
graph TD
    subgraph "Host Machine A"
        WA[rclaude wrapper A<br/>wrapperId: abc-123]
        PTYA[PTY A]
        WA --- PTYA
    end

    subgraph "Host Machine B"
        WB[rclaude wrapper B<br/>wrapperId: def-456]
        PTYB[PTY B]
        WB --- PTYB
    end

    subgraph "Concentrator"
        SS[Session Store<br/>sessionSockets: Map sessionId → Map wrapperId → ws<br/>terminalViewers: Map wrapperId → Set ws]
        WS[WebSocket Server]
        WS --> SS
    end

    subgraph "Browser"
        DASH[Dashboard]
        TERM[WebTerminal<br/>props: wrapperId]
        TABS[Wrapper Tabs<br/>one tab per wrapperId]
        TERM --> TABS
    end

    WA -->|"meta {sessionId, wrapperId: abc}"| WS
    WB -->|"meta {sessionId, wrapperId: def}"| WS

    TERM -->|"terminal_attach {wrapperId: abc}"| WS
    WS -->|"terminal_attach {wrapperId: abc}"| WA
    WA -->|"terminal_data {wrapperId: abc, data}"| WS
    WS -->|"terminal_data {wrapperId: abc, data}"| TERM
    TERM -->|"terminal_data {wrapperId: abc, data}"| WS
    WS -->|"terminal_data {wrapperId: abc, data}"| WA
```

## Terminal Message Routing

All terminal messages route by `wrapperId`, never `sessionId`:

```mermaid
sequenceDiagram
    participant Browser as Browser (WebTerminal)
    participant Conc as Concentrator
    participant Wrapper as rclaude (wrapperId)

    Note over Browser: User clicks TTY button<br/>resolves session.wrapperIds[0]

    Browser->>Conc: terminal_attach {wrapperId, cols, rows}
    Conc->>Conc: addTerminalViewer(wrapperId, browserWs)
    Conc->>Conc: getSessionSocketByWrapper(wrapperId)
    Conc->>Wrapper: terminal_attach {wrapperId, cols, rows}
    Wrapper->>Wrapper: Start PTY forwarding

    loop PTY output
        Wrapper->>Conc: terminal_data {wrapperId, data}
        Conc->>Conc: getTerminalViewers(wrapperId)
        Conc->>Browser: terminal_data {wrapperId, data}
    end

    loop User keystrokes
        Browser->>Conc: terminal_data {wrapperId, data}
        Conc->>Conc: getSessionSocketByWrapper(wrapperId)
        Conc->>Wrapper: terminal_data {wrapperId, data}
    end

    Browser->>Conc: terminal_detach {wrapperId}
    Conc->>Conc: removeTerminalViewer(wrapperId, browserWs)
    Note over Conc: If last viewer removed:
    Conc->>Wrapper: terminal_detach {wrapperId}
```

## Store & UI Routing

```mermaid
graph LR
    subgraph "Zustand Store"
        TWI[terminalWrapperId: string | null]
        ST[showTerminal: boolean]
        OT["openTerminal(wrapperId)"]
    end

    subgraph "session-detail.tsx"
        TTY[TTY Button click]
        TTY -->|"session.wrapperIds[0]"| OT
    end

    subgraph "app.tsx"
        KBD["Ctrl+Shift+T"]
        SW[Switcher select]
        KBD -->|"session.wrapperIds[0]"| OT
        SW -->|"session.wrapperIds[0]"| OT
    end

    subgraph "web-terminal.tsx"
        WT["WebTerminal(wrapperId)"]
        WTABS["Wrapper Tabs"]
        WT --> WTABS
        WTABS -->|"click tab"| OT
    end

    OT --> TWI
    OT --> ST
    TWI --> WT
```

## Session Lifecycle with Multiple Wrappers

```mermaid
sequenceDiagram
    participant W1 as Wrapper A (wrapperId: abc)
    participant W2 as Wrapper B (wrapperId: def)
    participant C as Concentrator
    participant D as Dashboard

    W1->>C: meta {sessionId: S1, wrapperId: abc}
    C->>C: setSessionSocket(S1, abc, ws1)
    C->>D: session_created {wrapperIds: [abc]}

    W2->>C: meta {sessionId: S1, wrapperId: def}
    Note over W2,C: Same sessionId via --continue
    C->>C: setSessionSocket(S1, def, ws2)
    C->>D: session_update {wrapperIds: [abc, def]}

    W2->>C: end {sessionId: S1}
    C->>C: removeSessionSocket(S1, def)
    C->>C: getActiveWrapperCount(S1) = 1
    Note over C: Still 1 wrapper alive - session stays active
    C->>D: session_update {wrapperIds: [abc]}

    W1->>C: end {sessionId: S1}
    C->>C: removeSessionSocket(S1, abc)
    C->>C: getActiveWrapperCount(S1) = 0
    Note over C: Last wrapper gone - NOW end the session
    C->>C: endSession(S1)
    C->>D: session_ended
```

## Revive Flow with Pre-assigned wrapperId

```mermaid
sequenceDiagram
    participant D as Dashboard
    participant C as Concentrator
    participant A as rclaude-agent
    participant R as revive-session.sh
    participant W as New rclaude

    D->>C: POST /sessions/{sessionId}/revive
    C->>C: Generate wrapperId = randomUUID()
    C->>A: revive {sessionId, cwd, wrapperId}
    A->>R: spawn with RCLAUDE_WRAPPER_ID env
    R->>R: tmux new-session with env
    R->>W: rclaude starts with RCLAUDE_WRAPPER_ID
    W->>C: meta {sessionId, wrapperId}
    Note over C: wrapperId matches pre-assigned -<br/>concentrator can correlate
```

## URL Hash Routing

| Hash | Meaning |
|------|---------|
| `#session/{sessionId}` | Select session in main panel |
| `#terminal/{wrapperId}` | Open terminal overlay for wrapper |
| `#popout-terminal/{wrapperId}` | Popout terminal window for wrapper |
