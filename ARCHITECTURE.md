# Remote-Claude Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        REMOTE-CLAUDE ARCHITECTURE                               │
└─────────────────────────────────────────────────────────────────────────────────┘

  TERMINAL 1                    TERMINAL 2                    TERMINAL N
  ──────────                    ──────────                    ──────────
       │                             │                             │
       ▼                             ▼                             ▼
┌─────────────┐              ┌─────────────┐              ┌─────────────┐
│   rclaude   │              │   rclaude   │              │   rclaude   │
│   wrapper   │              │   wrapper   │              │   wrapper   │
├─────────────┤              ├─────────────┤              ├─────────────┤
│ • Gen UUID  │              │ • Gen UUID  │              │ • Gen UUID  │
│ • Merge     │              │ • Merge     │              │ • Merge     │
│   settings  │              │   settings  │              │   settings  │
│ • Inject    │              │ • Inject    │              │ • Inject    │
│   hooks     │              │   hooks     │              │   hooks     │
│ • PTY pass  │              │ • PTY pass  │              │ • PTY pass  │
└──────┬──────┘              └──────┬──────┘              └──────┬──────┘
       │ spawns                     │                            │
       ▼                            ▼                            ▼
┌─────────────┐              ┌─────────────┐              ┌─────────────┐
│   claude    │              │   claude    │              │   claude    │
│  (actual)   │              │  (actual)   │              │  (actual)   │
├─────────────┤              ├─────────────┤              ├─────────────┤
│ --settings  │              │ --settings  │              │ --settings  │
│ /tmp/merged │              │ /tmp/merged │              │ /tmp/merged │
└──────┬──────┘              └──────┬──────┘              └──────┬──────┘
       │                            │                            │
       │ hooks fire                 │ hooks fire                 │ hooks fire
       │ (curl POST)                │ (curl POST)                │ (curl POST)
       ▼                            ▼                            ▼
┌─────────────┐              ┌─────────────┐              ┌─────────────┐
│ Local HTTP  │              │ Local HTTP  │              │ Local HTTP  │
│ :54321      │              │ :54322      │              │ :54323      │
└──────┬──────┘              └──────┬──────┘              └──────┬──────┘
       │                            │                            │
       │ WebSocket                  │ WebSocket                  │ WebSocket
       └────────────────────────────┼────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │        CONCENTRATOR           │
                    │         :9999                 │
                    ├───────────────────────────────┤
                    │  • Session Registry           │
                    │  • Event Aggregation          │
                    │  • Transcript Storage         │
                    │  • Image Hash Registry        │
                    │  • WebSocket Server           │
                    │  • REST API                   │
                    │  • Web Dashboard              │
                    └───────────────┬───────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
              ▼                     ▼                     ▼
       ┌────────────┐       ┌────────────┐       ┌────────────┐
       │  REST API  │       │  WebSocket │       │    Web     │
       │            │       │  /ws       │       │  Dashboard │
       ├────────────┤       ├────────────┤       ├────────────┤
       │ /sessions  │       │ subscribe  │       │ React SPA  │
       │ /events    │       │ to updates │       │ Real-time  │
       │ /file/:h   │       │            │       │ Transcript │
       │ /health    │       │            │       │ Events     │
       └────────────┘       └────────────┘       └────────────┘
```

## Hook Event Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│  claude (tool_use) ──► hook fires ──► curl POST ──► rclaude ──► WS ──► conc.    │
│                                                                                 │
│  Events captured:                                                               │
│  • SessionStart      • PreToolUse       • Notification                          │
│  • UserPromptSubmit  • PostToolUse      • Stop                                  │
│  • SessionEnd        • SubagentStart    • SubagentStop                          │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Image Serving Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│  Transcript contains: [Image: source: /path/to/screenshot.png]                  │
│                                    │                                            │
│                                    ▼                                            │
│  Concentrator scans transcript ──► Register path ──► Generate hash: "abc123"    │
│                                    │                                            │
│                                    ▼                                            │
│  Response includes: { images: [{ hash: "abc123", url: "/file/abc123.png" }] }   │
│                                    │                                            │
│                                    ▼                                            │
│  Dashboard renders: <img src="/file/abc123.png" />                              │
│                                    │                                            │
│                                    ▼                                            │
│  GET /file/abc123.png ──► Lookup hash ──► Serve /path/to/screenshot.png         │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Components

| Component | Binary | Port | Description |
|-----------|--------|------|-------------|
| rclaude | `bin/rclaude` | dynamic | Wrapper that spawns claude with hook injection |
| concentrator | `bin/concentrator` | 9999 | Aggregates sessions, serves dashboard |
| web | `web/dist/` | embedded | React dashboard (embedded in concentrator) |

## Quick Start

```bash
# Start concentrator (in background or separate terminal)
./bin/concentrator --verbose

# Use rclaude instead of claude
./bin/rclaude

# Open dashboard
open http://localhost:9999
```
