/**
 * Terminal-style Web UI for Concentrator
 * ASCII aesthetic, no framework needed
 */

export const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CLAUDE CONCENTRATOR</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --fg: #00ff00;
      --fg-dim: #007700;
      --fg-bright: #00ff88;
      --accent: #ffff00;
      --error: #ff3333;
      --border: #333;
      --selection: #003300;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
      font-size: 14px;
      line-height: 1.4;
      padding: 20px;
      min-height: 100vh;
    }

    ::selection {
      background: var(--selection);
      color: var(--fg-bright);
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    .header {
      border: 1px solid var(--fg-dim);
      padding: 10px 20px;
      margin-bottom: 20px;
      white-space: pre;
      font-size: 12px;
    }

    .header .title {
      color: var(--fg-bright);
    }

    .header .status {
      color: var(--accent);
    }

    .panels {
      display: grid;
      grid-template-columns: 400px 1fr;
      gap: 20px;
      height: calc(100vh - 180px);
    }

    .panel {
      border: 1px solid var(--fg-dim);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .panel-header {
      padding: 8px 12px;
      border-bottom: 1px solid var(--fg-dim);
      background: #111;
      color: var(--fg-bright);
      font-weight: bold;
    }

    .panel-content {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
    }

    .session-list {
      list-style: none;
    }

    .session-item {
      padding: 10px;
      border: 1px solid var(--border);
      margin-bottom: 8px;
      cursor: pointer;
      transition: all 0.1s;
    }

    .session-item:hover {
      border-color: var(--fg);
      background: #111;
    }

    .session-item.selected {
      border-color: var(--accent);
      background: #1a1a00;
    }

    .session-item .id {
      color: var(--fg-bright);
      font-weight: bold;
    }

    .session-item .cwd {
      color: var(--fg-dim);
      font-size: 12px;
      margin-top: 4px;
      word-break: break-all;
    }

    .session-item .meta {
      display: flex;
      gap: 15px;
      margin-top: 6px;
      font-size: 11px;
    }

    .session-item .status {
      padding: 2px 6px;
      font-size: 10px;
      text-transform: uppercase;
    }

    .session-item .status.active {
      color: #000;
      background: var(--fg);
    }

    .session-item .status.idle {
      color: #000;
      background: var(--accent);
    }

    .session-item .status.ended {
      color: #fff;
      background: #666;
    }

    .detail-section {
      margin-bottom: 20px;
    }

    .detail-section h3 {
      color: var(--accent);
      font-size: 12px;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .detail-grid {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 4px 10px;
      font-size: 13px;
    }

    .detail-grid dt {
      color: var(--fg-dim);
    }

    .detail-grid dd {
      color: var(--fg);
      word-break: break-all;
    }

    .event-log {
      font-size: 12px;
    }

    .event-item {
      padding: 6px 8px;
      border-left: 2px solid var(--border);
      margin-bottom: 4px;
      background: #0d0d0d;
    }

    .event-item:hover {
      background: #151515;
    }

    .event-item .time {
      color: var(--fg-dim);
      font-size: 10px;
    }

    .event-item .type {
      color: var(--accent);
      font-weight: bold;
    }

    .event-item .type.SessionStart { color: #00ff00; }
    .event-item .type.SessionEnd { color: #ff6666; }
    .event-item .type.PreToolUse { color: #66ccff; }
    .event-item .type.PostToolUse { color: #6699ff; }
    .event-item .type.UserPromptSubmit { color: #ff66ff; }
    .event-item .type.Stop { color: #ffaa00; }

    .event-item .detail {
      color: var(--fg-dim);
      font-size: 11px;
      margin-top: 2px;
    }

    .empty-state {
      color: var(--fg-dim);
      text-align: center;
      padding: 40px;
    }

    .empty-state pre {
      font-size: 10px;
      margin-bottom: 20px;
      color: var(--fg-dim);
    }

    .refresh-indicator {
      position: fixed;
      top: 10px;
      right: 20px;
      font-size: 10px;
      color: var(--fg-dim);
    }

    .refresh-indicator.active {
      color: var(--fg);
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    .cursor {
      animation: blink 1s infinite;
    }

    /* Scrollbar styling */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-track {
      background: var(--bg);
    }

    ::-webkit-scrollbar-thumb {
      background: var(--fg-dim);
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--fg);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
<span class="title">┌─────────────────────────────────────────────────────────────────────────────┐
│   ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗                           │
│  ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝                           │
│  ██║     ██║     ███████║██║   ██║██║  ██║█████╗                             │
│  ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝                             │
│  ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗                           │
│   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝  CONCENTRATOR            │
├─────────────────────────────────────────────────────────────────────────────┤
│  <span class="status" id="status-line">Connecting...</span>
└─────────────────────────────────────────────────────────────────────────────┘</span>
    </div>

    <div class="panels">
      <div class="panel">
        <div class="panel-header">[ SESSIONS ]</div>
        <div class="panel-content">
          <ul class="session-list" id="session-list">
            <li class="empty-state">
              <pre>
    No sessions yet

    Start a session with:
    $ rclaude
              </pre>
            </li>
          </ul>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">[ DETAILS ]</div>
        <div class="panel-content" id="detail-panel">
          <div class="empty-state">
            <pre>
  ┌─────────────────────────────┐
  │                             │
  │   Select a session to      │
  │   view details             │
  │                             │
  │   <span class="cursor">_</span>                         │
  │                             │
  └─────────────────────────────┘
            </pre>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="refresh-indicator" id="refresh-indicator">● AUTO-REFRESH</div>

  <script>
    const API_BASE = window.location.origin;
    let selectedSessionId = null;
    let sessions = [];
    let refreshInterval = null;

    function formatTime(timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleTimeString('en-US', { hour12: false });
    }

    function formatAge(timestamp) {
      const seconds = Math.floor((Date.now() - timestamp) / 1000);
      if (seconds < 60) return seconds + 's ago';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      const hours = Math.floor(minutes / 60);
      return hours + 'h ' + (minutes % 60) + 'm ago';
    }

    function truncatePath(path, maxLen = 40) {
      if (path.length <= maxLen) return path;
      return '...' + path.slice(-maxLen + 3);
    }

    function getEventDetail(event) {
      const data = event.data || {};
      switch (event.hookEvent) {
        case 'PreToolUse':
        case 'PostToolUse':
          return data.tool_name || '';
        case 'UserPromptSubmit':
          const prompt = data.prompt || '';
          return prompt.length > 50 ? prompt.slice(0, 50) + '...' : prompt;
        case 'Stop':
          return data.reason || '';
        default:
          return '';
      }
    }

    async function fetchSessions() {
      try {
        const res = await fetch(API_BASE + '/sessions');
        sessions = await res.json();
        renderSessionList();
        updateStatusLine();
        return true;
      } catch (err) {
        console.error('Failed to fetch sessions:', err);
        return false;
      }
    }

    async function fetchSessionEvents(sessionId) {
      try {
        const res = await fetch(API_BASE + '/sessions/' + sessionId + '/events?limit=100');
        return await res.json();
      } catch (err) {
        console.error('Failed to fetch events:', err);
        return [];
      }
    }

    function renderSessionList() {
      const list = document.getElementById('session-list');

      if (sessions.length === 0) {
        list.innerHTML = \`
          <li class="empty-state">
            <pre>
    No sessions yet

    Start a session with:
    $ rclaude
            </pre>
          </li>
        \`;
        return;
      }

      // Sort: active first, then by lastActivity
      const sorted = [...sessions].sort((a, b) => {
        if (a.status === 'active' && b.status !== 'active') return -1;
        if (a.status !== 'active' && b.status === 'active') return 1;
        return b.lastActivity - a.lastActivity;
      });

      list.innerHTML = sorted.map(s => \`
        <li class="session-item \${s.id === selectedSessionId ? 'selected' : ''}"
            data-id="\${s.id}"
            onclick="selectSession('\${s.id}')">
          <div class="id">\${s.id.slice(0, 8)}...</div>
          <div class="cwd">\${truncatePath(s.cwd)}</div>
          <div class="meta">
            <span class="status \${s.status}">\${s.status}</span>
            <span>\${formatAge(s.lastActivity)}</span>
            <span>\${s.eventCount} events</span>
            \${s.model ? '<span>' + s.model.split('-').slice(-2).join('-') + '</span>' : ''}
          </div>
        </li>
      \`).join('');
    }

    async function selectSession(sessionId) {
      selectedSessionId = sessionId;
      renderSessionList();

      const session = sessions.find(s => s.id === sessionId);
      const events = await fetchSessionEvents(sessionId);

      renderDetailPanel(session, events);
    }

    function renderDetailPanel(session, events) {
      const panel = document.getElementById('detail-panel');

      if (!session) {
        panel.innerHTML = \`
          <div class="empty-state">
            <pre>
  ┌─────────────────────────────┐
  │                             │
  │   Session not found        │
  │                             │
  └─────────────────────────────┘
            </pre>
          </div>
        \`;
        return;
      }

      const eventsHtml = events.length === 0
        ? '<div class="empty-state">No events yet</div>'
        : events.slice().reverse().map(e => \`
          <div class="event-item">
            <span class="time">\${formatTime(e.timestamp)}</span>
            <span class="type \${e.hookEvent}">\${e.hookEvent}</span>
            \${getEventDetail(e) ? '<div class="detail">' + escapeHtml(getEventDetail(e)) + '</div>' : ''}
          </div>
        \`).join('');

      panel.innerHTML = \`
        <div class="detail-section">
          <h3>Session Info</h3>
          <dl class="detail-grid">
            <dt>ID</dt>
            <dd>\${session.id}</dd>
            <dt>Status</dt>
            <dd><span class="status \${session.status}">\${session.status}</span></dd>
            <dt>CWD</dt>
            <dd>\${session.cwd}</dd>
            <dt>Model</dt>
            <dd>\${session.model || 'unknown'}</dd>
            <dt>Started</dt>
            <dd>\${new Date(session.startedAt).toLocaleString()}</dd>
            <dt>Last Activity</dt>
            <dd>\${formatAge(session.lastActivity)}</dd>
            <dt>Events</dt>
            <dd>\${session.eventCount}</dd>
          </dl>
        </div>

        <div class="detail-section">
          <h3>Event Log</h3>
          <div class="event-log">
            \${eventsHtml}
          </div>
        </div>
      \`;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function updateStatusLine() {
      const active = sessions.filter(s => s.status === 'active').length;
      const idle = sessions.filter(s => s.status === 'idle').length;
      const ended = sessions.filter(s => s.status === 'ended').length;

      document.getElementById('status-line').textContent =
        \`Sessions: \${active} active, \${idle} idle, \${ended} ended | Total: \${sessions.length}\`;
    }

    async function refresh() {
      const indicator = document.getElementById('refresh-indicator');
      indicator.classList.add('active');

      await fetchSessions();

      if (selectedSessionId) {
        const session = sessions.find(s => s.id === selectedSessionId);
        if (session) {
          const events = await fetchSessionEvents(selectedSessionId);
          renderDetailPanel(session, events);
        }
      }

      setTimeout(() => indicator.classList.remove('active'), 200);
    }

    // Initial load
    refresh();

    // Auto-refresh every 2 seconds
    refreshInterval = setInterval(refresh, 2000);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'r') {
        refresh();
      } else if (e.key === 'Escape') {
        selectedSessionId = null;
        renderSessionList();
        document.getElementById('detail-panel').innerHTML = \`
          <div class="empty-state">
            <pre>
  ┌─────────────────────────────┐
  │                             │
  │   Select a session to      │
  │   view details             │
  │                             │
  │   <span class="cursor">_</span>                         │
  │                             │
  └─────────────────────────────┘
            </pre>
          </div>
        \`;
      }
    });
  </script>
</body>
</html>`;
