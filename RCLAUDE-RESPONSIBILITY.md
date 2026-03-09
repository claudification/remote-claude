# Concentrator Decoupling: Architecture Research

Making the concentrator "dumb" -- no filesystem access, deployable anywhere, multi-host capable.

## Current State: What the Concentrator Reads from Disk

### 1. Transcript JSONL Files (Heavy)

**Where:** `api.ts` lines 497-559 (main transcript), 562-626 (subagent transcript)\
**What:** Reads `~/.claude/projects/.../session.jsonl` files, parses JSONL, extracts last N entries, processes inline images (base64 extraction + file path references).\
**How it gets the path:** `session.transcriptPath` is set from `SessionStart` hook event data (`transcript_path` field) -- so rclaude already reports this.\
**Path jail:** Transcript paths go through `resolveInJail()` which maps host paths to container paths (e.g. `/Users/jonas/.claude` -> `/data/transcripts`) and validates they're within allowed roots.\
**Docker mount:** `${CLAUDE_DIR:-~/.claude}:/data/transcripts:ro` in docker-compose.yml.

Subagent transcripts are derived from the parent: `{dir}/subagents/agent-{agentId}.jsonl` or from `agent.transcriptPath` (set on `SubagentStop`).

### 2. Image/File Serving (Medium)

**Where:** `api.ts` lines 363-419\
**Two types:**
- **Blob registry** (in-memory): Base64 images extracted from transcripts or uploaded via `/api/files`. Already filesystem-independent -- stored as `Uint8Array` in memory.
- **File registry** (filesystem): `[Image: source: /path/to/file.ext]` references in transcripts. Maps hash -> absolute path on host. Served through `resolveInJail()` + `Bun.file()`.

The file registry is the problem. When a transcript references a file image, the concentrator needs to read that file from disk.

### 3. Auth State (auth.json + auth.secret)

**Where:** `auth.ts` lines 67-115\
**What:** `auth.json` stores users, invites, sessions. `auth.secret` stores the HMAC key for session token signing.\
**Location:** `{cacheDir}/auth.json` and `{cacheDir}/auth.secret`\
**Docker mount:** `concentrator-data:/data/cache` (a named Docker volume, NOT a host bind mount)

This is self-contained. The auth state lives in the concentrator's own data volume and has nothing to do with the host filesystem.

### 4. Session Cache Persistence (sessions.json)

**Where:** `session-store.ts` lines 254-292\
**What:** Persists session metadata (without events) to `{cacheDir}/sessions.json` for survival across restarts.\
**Docker mount:** Same `concentrator-data:/data/cache` volume.

Also self-contained. No host filesystem dependency.

### 5. Project Settings (project-settings.json)

**Where:** `project-settings.ts`\
**What:** Label/icon/color per project path. Stored in `{cacheDir}/project-settings.json`.\
**Docker mount:** Same `concentrator-data:/data/cache` volume.

Self-contained.

### 6. Push Notification State

**Where:** `push.ts`\
**What:** VAPID keys come from env vars. Subscriptions are in-memory only (lost on restart).\
No filesystem dependency.

### 7. Web Dashboard Assets

**Where:** `api.ts` lines 270-344\
**What:** Serves `web/dist/` for the SPA dashboard. Either embedded in binary or served from `--web-dir`.\
**Docker mount:** `./web/dist:/srv/web:ro`

This is static assets. The concentrator just serves them -- no host data dependency.

### 8. PID File

**Where:** `index.ts` line 256\
**What:** Writes `concentrator.pid` to cacheDir so CLI can send signals.\
Trivial, self-contained.

---

## Summary: What Must Move

| Dependency | Currently | Filesystem? | Must Move? |
|---|---|---|---|
| Transcript JSONL reading | Concentrator reads via path-jail | YES - host `~/.claude` | YES |
| File image serving | Concentrator reads via path-jail | YES - host filesystem | YES |
| Blob image serving | In-memory blob registry | No | No |
| Auth state | Concentrator's own volume | No | No |
| Session cache | Concentrator's own volume | No | No |
| Project settings | Concentrator's own volume | No | No |
| Push subscriptions | In-memory | No | No |
| Web assets | Static files, embedded or mounted | No | No |
| Transcription API | Calls OpenRouter, no disk | No | No |

**Only two things actually touch the host filesystem:** transcript reading and file image serving. Everything else is already self-contained.

---

## Proposed Architecture

### rclaude Becomes the Data Source

rclaude already sends hook events over WebSocket. It needs to also:

1. **Stream transcript entries** as they appear in the JSONL file
2. **Serve file requests** proxied through the concentrator
3. **Stream subagent transcripts** when they start
4. **Push inline images** as blobs (already happens partially -- base64 images in hook data)

### New WS Message Types

```
rclaude -> concentrator:
  transcript_entries    { sessionId, entries: TranscriptEntry[], isInitial: boolean }
  file_response         { requestId, data: base64, mediaType, error? }
  subagent_transcript   { sessionId, agentId, entries: TranscriptEntry[] }

concentrator -> rclaude:
  file_request          { requestId, path: string }
  transcript_request    { sessionId, limit?: number }  // for initial load on dashboard open
```

### Concentrator Changes

1. **Remove:** `path-jail.ts` entirely, `--allow-root`, `--path-map`, `~/.claude` volume mount
2. **Remove:** Transcript JSONL reading from API handlers -- replace with cached data from rclaude
3. **Remove:** File registry filesystem reads -- proxy through rclaude or serve from blob registry
4. **Add:** Transcript cache per session (ring buffer of entries received from rclaude)
5. **Add:** File request proxying -- dashboard asks concentrator, concentrator asks rclaude, rclaude responds

### rclaude Changes

1. **Add:** JSONL file watcher -- watch `transcriptPath` for changes, parse new lines, send to concentrator
2. **Add:** Image processing -- currently done by concentrator's `processImagesInEntry()`. Move to rclaude.
3. **Add:** File request handler -- when concentrator proxies a file request, read the file locally and return bytes
4. **Add:** Subagent transcript watching -- when SubagentStart fires, start watching the subagent's JSONL too
5. **Keep:** All current hook event forwarding, terminal relay, task polling

---

## Migration Path (Incremental)

### Phase 1: Transcript Streaming (rclaude pushes, concentrator caches)

1. Add JSONL file watcher to rclaude. On new lines: parse, process images (extract base64 -> blob), send `transcript_entries` message to concentrator.
2. Add transcript cache to concentrator session store. Store entries received from rclaude.
3. Update concentrator API: when transcript is requested, serve from cache first. Fall back to filesystem if cache is empty AND filesystem is available (backward compat during migration).
4. rclaude sends initial transcript on connect (last N entries) so dashboard works immediately.

This phase is backward-compatible. Old rclaude instances that don't stream transcripts still work via filesystem fallback.

### Phase 2: File Proxying (concentrator asks rclaude for files)

1. When dashboard requests `/file/{hash}` and the file is in the file registry (not blob), concentrator sends `file_request` to the rclaude that owns that session.
2. rclaude reads the file locally, responds with bytes.
3. Concentrator caches the blob (it already has `blobRegistry` with TTL) and serves to dashboard.
4. After this, filesystem file access is proxied, not direct. The volume mount becomes unnecessary for file serving.

### Phase 3: Remove Filesystem Dependencies

1. Remove `--allow-root`, `--path-map`, `path-jail.ts`
2. Remove `~/.claude` volume mount from docker-compose.yml
3. Remove transcript JSONL reading code from `api.ts`
4. Concentrator is now purely network-dependent, zero host filesystem access

### Phase 4: Multi-Host Support

1. Concentrator tracks which rclaude WebSocket owns which session (already does this via `sessionSockets` map)
2. File requests and transcript requests are routed to the correct rclaude instance
3. Multiple rclaude clients from different hosts connect to same concentrator
4. Sessions are tagged with a host identifier (hostname or client ID)

---

## Challenges and Open Questions

### 1. Bandwidth: Streaming Full Transcripts

**Problem:** Transcript JSONL files can be large. Streaming every line as it's written could be bandwidth-intensive, especially with base64 images embedded in entries.

**Mitigation:**
- rclaude already needs to process images (extract base64 -> blob, register hashes). Send only the stripped entry + blob separately.
- Send entries incrementally (only new lines since last send), not the whole file.
- For initial load (dashboard opens on existing session), rclaude sends the last N entries on demand (concentrator requests it).

**Assessment:** Manageable. Hook events already go through the wire. Transcript entries are typically smaller than the base64 images they contain, and image extraction means we send the blob once and reference by hash thereafter.

### 2. Latency: File Requests Round-Trip Through rclaude

**Problem:** Dashboard requests `/file/{hash}` -> concentrator -> rclaude -> read file -> rclaude -> concentrator -> dashboard. That's a full round-trip through the WebSocket.

**Mitigation:**
- Concentrator caches blobs after first fetch (already has `blobRegistry` with 24h TTL).
- Most images come from transcript processing, where rclaude can push the blob proactively -- no round-trip needed.
- File path references (`[Image: source: /path]`) are the only ones needing on-demand fetch, and these are less common than inline base64.

**Assessment:** Acceptable. First load has latency; subsequent loads are cached. And proactive push during transcript streaming eliminates most cases.

### 3. Multiple rclaude Clients: Routing

**Problem:** With multiple hosts, the concentrator needs to know which rclaude to ask for a file or transcript.

**Solution:** Already solved. `sessionStore.getSessionSocket(sessionId)` returns the WebSocket for a specific session. File requests include the session context (which session's transcript referenced the image), so routing is straightforward.

**Edge case:** What if the file is referenced by multiple sessions? The file registry maps hash -> path, but the path only exists on one host. Solution: track which rclaude registered the file hash, and route the request to that rclaude.

### 4. rclaude Disconnection: Data Availability

**Problem:** When rclaude disconnects (session ends, network drops), the concentrator can't fetch transcripts or files anymore.

**Mitigation:**
- Transcript entries were already cached by concentrator as they were streamed. They survive disconnection.
- Blobs (extracted images) were already pushed to concentrator's blob registry. They survive disconnection (24h TTL).
- File path references that were never fetched become unavailable. This is an acceptable degradation -- the transcript text is still there, just the image can't be loaded.

**Assessment:** Good enough. The important data (transcript content, inline images) is cached. On-demand file references degrade gracefully.

### 5. Auth: Self-Contained?

**Answer:** YES. Auth is already fully self-contained. `auth.json` and `auth.secret` live in the concentrator's own data volume. No host filesystem dependency. No changes needed.

### 6. JSONL File Watching

**Problem:** rclaude needs to watch the transcript JSONL file for new lines. This means:
- Knowing the transcript path (already received via `SessionStart` hook data)
- Efficiently watching for appends (not re-reading the whole file)
- Handling subagent transcripts (discovered via `SubagentStart`/`SubagentStop` events)

**Implementation:** Use `fs.watch()` or polling (Bun's file watcher) on the JSONL file. Track file offset, read only new bytes, parse new lines. This is a well-understood pattern.

**Subagents:** rclaude already receives `SubagentStart` with `agent_id` and can derive the subagent transcript path. Watch those files too.

### 7. Image Processing Location

**Currently:** `processImagesInEntry()` runs in the concentrator. It extracts base64 blocks, registers them in the blob registry, and replaces them with lightweight placeholders.

**Proposed:** Move this to rclaude. rclaude processes entries before sending them over the wire. This means:
- Less bandwidth (base64 data is stripped before transmission -- only the blob is sent once separately)
- rclaude needs the blob registry URL scheme (or the concentrator assigns URLs on receipt)
- Concentrator still needs a blob registry for serving, but it receives pre-processed entries

**Alternative:** rclaude sends raw entries, concentrator processes them. This keeps the processing logic centralized but means more bandwidth. Given that the processing is straightforward string parsing and base64 decoding, either location works.

### 8. Transcription API (`/api/transcribe`)

This endpoint calls external APIs (OpenRouter Whisper + Haiku). It has zero filesystem dependency. No changes needed. It can run in the concentrator just fine since it only needs `OPENROUTER_API_KEY` env var.

### 9. Session Revive

Currently `POST /sessions/:id/revive` sends a message to the host agent (rclaude-agent). In a multi-host world, the revive command needs to go to the right host's agent. The agent socket is already tracked per connection, but there's only one agent slot. This needs to become per-host or the revive feature needs to route through the session's rclaude connection.

---

## Viability Assessment

### Can This Work? YES.

The concentrator's filesystem dependencies are surprisingly narrow:
1. Transcript JSONL reading
2. File image serving

Both can be replaced by having rclaude push data over the existing WebSocket connection. The rest (auth, session cache, project settings, push) is already self-contained in the concentrator's own data volume.

### What Are the Dealbreakers?

**None identified.** The hardest part is the JSONL file watching in rclaude, and that's a well-solved problem. The WebSocket protocol already supports bidirectional communication -- adding transcript streaming and file proxying is incremental.

### Effort Estimate

- **Phase 1 (Transcript streaming):** Medium. JSONL watcher in rclaude, transcript cache in concentrator, new WS message types. This is the bulk of the work.
- **Phase 2 (File proxying):** Small. Request/response over existing WS, blob caching already exists.
- **Phase 3 (Cleanup):** Small. Delete path-jail, remove volume mounts, update Dockerfile.
- **Phase 4 (Multi-host):** Small-to-medium. Mostly routing logic, session-to-client mapping is already there.

### What Gets Better

- Concentrator can run anywhere (cloud VM, different server, Fly.io, whatever)
- No more Docker volume mount gymnastics with path mappings
- No more path-jail security surface area
- Multiple developers' machines can feed into one dashboard
- Concentrator becomes stateless-ish (only its own cache volume, not host data)
- Cleaner separation of concerns

### What Gets Worse

- More WS message types and protocol complexity
- rclaude becomes heavier (file watching, image processing, file serving)
- First-load latency for file images that weren't proactively pushed
- If rclaude crashes mid-session, concentrator has whatever was cached -- no ability to go read the JSONL file directly

### Risk: rclaude Backward Compatibility

Old rclaude versions that don't stream transcripts would need the filesystem fallback. Phase 1's approach of "cache first, filesystem fallback" handles this, but after Phase 3 (filesystem removal), old clients would get empty transcripts. This is acceptable -- just require a matching rclaude version when upgrading the concentrator.
