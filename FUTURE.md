# Future Improvements

## Hook Forwarder - Replace forwarder.sh

**Priority:** Medium\
**Impact:** ~80% reduction in hook event latency

Current flow: `hook -> bash -> curl -> HTTP -> rclaude` (~20-50ms per event)\
Target flow: `hook -> compiled binary -> rclaude` (~1-5ms per event)

### Phase 1: Compiled Bun forwarder

Replace `forwarder.sh` with a compiled Bun binary. Eliminates bash+curl process
spawns (the main latency source). Still uses HTTP to localhost.

- Single `bun build --compile` per target platform
- Drop-in replacement, same HTTP IPC
- Cross-platform: `bun build --target=bun-{platform}-{arch}`

### Phase 2: UDS (Unix Domain Socket) transport

Add UDS support alongside HTTP. Kernel copies bytes directly between processes -
no TCP/IP stack, no HTTP parsing overhead.

- rclaude binds `/tmp/rclaude-{pid}.sock` on startup
- Forwarder tries UDS first, falls back to HTTP
- Bun has native `net.createServer({ path })` support
- Works on macOS, Linux, and Windows 10+ (AF_UNIX)
- ~0.5ms improvement over localhost TCP (marginal, but free)

### Phase 3: Rust forwarder (optional, diminishing returns)

Tiny Rust binary (~500KB) for the hook forwarder. Sub-millisecond startup,
minimal memory. Only worth it if hook volume is extreme (thousands/sec).

- Cross-compile via `cross-rs` or zig linker
- Targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64
- GitHub Actions matrix build, ~2 min total
- UDS-first with HTTP fallback
