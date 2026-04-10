---
title: "Plan mode: full implementation (config + UI + approval flow)"
priority: high
tags: [headless, plan-mode, feature, dashboard]
created: 2026-04-10T18:00:00.000Z
completed: 2026-04-10
depends_on: []
relates_to: [headless-input-fixes, plan-mode-headless, when-there-is-a-exit-plan-we-should-probably-make-sure-that-]
---

## Approved plan (2026-04-10)

### Flow

```
CC calls EnterPlanMode
  -> wrapper: check allowPlanMode config
     -> NO:  deny immediately (control_response)
     -> YES: auto-approve, set session.planMode = true
             broadcast session_update (sidebar icon + transcript tint)

CC calls ExitPlanMode (input: { plan, planFilePath, allowedPrompts })
  -> wrapper: intercept, forward plan_approval to concentrator
  -> concentrator: relay to dashboard
  -> dashboard: open dialog (reuse DialogModal renderer)
     -> user: APPROVE / REJECT / APPROVE WITH FEEDBACK
  -> concentrator: relay plan_approval_response
  -> wrapper: send control_response to CC
     -> approve: { behavior: 'allow' }
     -> feedback: { behavior: 'allow', updatedInput: { feedback: '...' } }
     -> reject:  { behavior: 'deny', message: '...' }
  -> wrapper: set session.planMode = false, broadcast
```

### Dialog layer changes

DialogModal already renders arbitrary layouts. Plan approval is just another
layout with a different submission backend.

Add `source` field to pending dialogs:

```ts
interface PendingDialog {
  dialogId: string
  layout: DialogLayout
  timestamp: number
  source: 'mcp' | 'plan_approval'  // NEW
  meta?: Record<string, unknown>   // NEW - requestId, toolUseId, etc.
}
```

When user submits:
- `source: 'mcp'` -> existing path (MCP tool result)
- `source: 'plan_approval'` -> send `plan_approval_response` WS message

DialogModal component itself doesn't change. Only submission routing.

Plan approval dialog layout (built from standard components):
```ts
{
  title: 'Plan Approval',
  body: [
    { type: 'Alert', intent: 'info', content: 'Session wants to exit plan mode' },
    { type: 'Markdown', content: planContent },
    { type: 'Divider' },
    { type: 'TextInput', id: 'feedback', label: 'Feedback (optional)',
      placeholder: 'Suggestions, changes...', multiline: true },
    { type: 'Options', id: '_action', options: [
      { value: 'approve', label: 'Approve' },
      { value: 'reject', label: 'Reject' },
    ], default: 'approve' },
  ]
}
```

### Per-session allowPlanMode

In project settings (`project-settings.ts`):
```ts
interface ProjectSettings {
  // ... existing
  allowPlanMode?: boolean  // default: true
}
```

Wrapper checks on EnterPlanMode. Spawned agent sessions default to false.

### Visual indicators

- Sidebar: blueprint/drafting icon when `session.planMode === true` (blue/indigo)
- Transcript: subtle background tint `bg-blue-950/20`, smooth transition

### Session state

```ts
interface Session {
  planMode?: boolean  // set on EnterPlanMode, cleared on ExitPlanMode/Stop
}
```

Wrapper sends `plan_mode_changed` message on approve/exit.

### Files to modify

| File | Change |
|------|--------|
| `src/wrapper/headless-lifecycle.ts` | Intercept ExitPlanMode -> forward plan_approval |
| `src/wrapper/index.ts` | Handle `plan_approval_response` from WS |
| `src/concentrator/handlers/permissions.ts` | Add plan_approval relay |
| `src/concentrator/session-store.ts` | Add `planMode` to Session |
| `src/concentrator/project-settings.ts` | Add `allowPlanMode` field |
| `src/shared/protocol.ts` | Add plan_approval message types |
| `web/src/hooks/use-sessions.ts` | planMode in Session type |
| `web/src/hooks/use-websocket.ts` | Route plan_approval -> pending dialog |
| `web/src/components/session-detail.tsx` | Transcript tint |
| `web/src/components/session-list.tsx` | Sidebar icon |
| `web/src/components/dialog.tsx` | source/meta on PendingDialog, route submit |

### Implementation order

1. Add `planMode` to session state + `allowPlanMode` to project settings
2. Wrapper: EnterPlanMode checks config, sets planMode on approve
3. Wrapper: ExitPlanMode intercepts and forwards plan content
4. Concentrator: plan_approval relay handlers
5. Dashboard: route plan_approval into dialog system with `source: 'plan_approval'`
6. Dashboard: dialog submit routing by source
7. Visual indicators (sidebar icon + transcript tint)
8. Spawned sessions: default `allowPlanMode: false`

## Implementation notes (2026-04-10)

### Deviations from plan

1. **`allowPlanMode` location:** Plan said `project-settings.ts` (concentrator-side).
   Implemented in `rclaude.json` + `permission-rules.ts` (wrapper-side) instead, because
   the wrapper must respond to EnterPlanMode immediately without a round-trip to the
   concentrator. Also exposed in `ProjectSettings` interface for future UI toggle.
   Env var `RCLAUDE_NO_PLAN_MODE=1` for spawned agents.

2. **Separate handler file:** Plan said add to `permissions.ts`. Created
   `handlers/plan-approval.ts` instead -- cleaner separation of concerns.

3. **Plan doesn't clear on Stop:** Plan said `cleared on ExitPlanMode/Stop`. Implemented
   clear only on ExitPlanMode and session end. Stop doesn't exit plan mode -- CC persists
   plan mode across turns.

4. **No `headless-lifecycle.ts` rename:** Plan referenced this file but the actual file
   already existed with this name. No structural change needed.

5. **Dialog layout built client-side:** The `plan_approval` WS message carries raw plan
   content. The dashboard's `use-websocket.ts` constructs the DialogLayout on receipt
   (Alert + Markdown + TextInput + Options). This avoids coupling the wrapper to dialog
   component types.

6. **Plan content not in ExitPlanMode input:** CC's `can_use_tool` for ExitPlanMode only
   sends `allowedPrompts` in the input. The plan content is written to
   `~/.claude/plans/{slug}.md` before the tool fires. Added `readLatestPlanFile()` helper
   that reads the most recently modified `.md` from that directory as fallback when
   `input.plan` is empty. Verified by reading CC 2.1.97 source: `ExitPlanModeInput` schema
   has only `allowedPrompts`; `plan`/`planFilePath` are in an extended schema marked
   "injected by normalizeToolInput from disk" but this injection may not happen before
   the `can_use_tool` control_request is sent.

### Files modified

| File | Change |
|------|--------|
| `src/shared/protocol.ts` | Added `PlanApprovalRequest`, `PlanApprovalResponse`, `PlanModeChanged` types; `planMode` on Session/SessionSummary; `allowPlanMode` on ProjectSettings; `'plan_approval'` in pendingAttention union |
| `src/wrapper/permission-rules.ts` | Added `isPlanModeAllowed()` to RulesEngine (reads `allowPlanMode` from rclaude.json + `RCLAUDE_NO_PLAN_MODE` env) |
| `src/wrapper/headless-lifecycle.ts` | Replaced auto-approve for EnterPlanMode/ExitPlanMode with config check + plan_approval forwarding |
| `src/wrapper/ws-client.ts` | Added `onPlanApprovalResponse` callback + dispatch |
| `src/wrapper/index.ts` | Added `onPlanApprovalResponse` handler: routes approve/feedback/reject to CC via `sendPermissionResponse`, broadcasts `plan_mode_changed` |
| `src/concentrator/handlers/plan-approval.ts` | NEW: relay handlers for `plan_approval`, `plan_approval_response`, `plan_mode_changed` |
| `src/concentrator/handlers/index.ts` | Registered plan approval handlers |
| `src/concentrator/session-store.ts` | `planMode` in session summary; clear on session end |
| `web/src/lib/types.ts` | Added `planMode` + `'plan_approval'` to client Session type |
| `web/src/hooks/use-sessions.ts` | Extended `pendingDialogs` with `source`/`meta`; submit/dismiss routing for plan_approval |
| `web/src/hooks/use-websocket.ts` | Added `plan_approval` case: builds DialogLayout from plan content, stores with `source: 'plan_approval'`; maps `planMode` from summary |
| `web/src/components/session-list.tsx` | Blue PLAN badge in sidebar |
| `web/src/components/session-detail.tsx` | Blue PLAN badge in header; `bg-blue-950/20` transcript tint |
