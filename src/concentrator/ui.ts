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
      --cyan: #00ffff;
      --magenta: #ff66ff;
      --orange: #ffaa00;
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
      max-width: 1400px;
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
      grid-template-columns: 350px 1fr;
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
      flex-wrap: wrap;
    }

    .session-item .model-name {
      color: var(--cyan);
    }

    .badge {
      padding: 2px 6px;
      font-size: 10px;
      text-transform: uppercase;
    }

    .badge.active {
      color: #000;
      background: var(--fg);
    }

    .badge.idle {
      color: #000;
      background: var(--accent);
    }

    .badge.ended {
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
      padding: 8px 10px;
      border-left: 3px solid var(--border);
      margin-bottom: 6px;
      background: #0d0d0d;
    }

    .event-item:hover {
      background: #151515;
    }

    .event-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 4px;
    }

    .event-item .time {
      color: var(--fg-dim);
      font-size: 10px;
    }

    .event-item .type {
      font-weight: bold;
      padding: 1px 5px;
      font-size: 11px;
    }

    .event-item.SessionStart { border-color: #00ff00; }
    .event-item.SessionStart .type { color: #00ff00; }

    .event-item.SessionEnd { border-color: #ff6666; }
    .event-item.SessionEnd .type { color: #ff6666; }

    .event-item.PreToolUse { border-color: #66ccff; }
    .event-item.PreToolUse .type { color: #66ccff; }

    .event-item.PostToolUse { border-color: #6699ff; }
    .event-item.PostToolUse .type { color: #6699ff; }

    .event-item.UserPromptSubmit { border-color: #ff66ff; }
    .event-item.UserPromptSubmit .type { color: #ff66ff; }

    .event-item.Stop { border-color: #ffaa00; }
    .event-item.Stop .type { color: #ffaa00; }

    .event-item.Notification { border-color: #888; }
    .event-item.Notification .type { color: #888; }

    .event-detail {
      margin-top: 6px;
      padding: 6px 8px;
      background: #000;
      border-radius: 2px;
      font-size: 11px;
    }

    .event-detail .label {
      color: var(--fg-dim);
      margin-right: 6px;
    }

    .event-detail .value {
      color: var(--fg);
    }

    .event-detail .tool-name {
      color: var(--cyan);
      font-weight: bold;
    }

    .event-detail .command {
      color: var(--accent);
      font-family: inherit;
    }

    .event-detail .prompt-text {
      color: var(--magenta);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .event-detail .output {
      color: #aaa;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 150px;
      overflow-y: auto;
      margin-top: 4px;
      padding: 4px;
      background: #050505;
    }

    .event-detail .source {
      color: var(--orange);
    }

    .event-detail .notification-msg {
      color: #888;
      font-style: italic;
    }

    /* Transcript styles */
    .transcript-section {
      margin-bottom: 20px;
    }

    .transcript-entry {
      padding: 10px 12px;
      margin-bottom: 8px;
      border-left: 3px solid var(--border);
      background: #0d0d0d;
    }

    .transcript-entry.assistant {
      border-color: var(--fg);
    }

    .transcript-entry.user {
      border-color: var(--magenta);
    }

    .transcript-entry.tool_use {
      border-color: var(--cyan);
    }

    .transcript-entry.tool_result {
      border-color: var(--orange);
    }

    .transcript-entry .entry-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
      font-size: 11px;
    }

    .transcript-entry .entry-role {
      font-weight: bold;
      text-transform: uppercase;
      font-size: 10px;
      padding: 2px 6px;
    }

    .transcript-entry.assistant .entry-role {
      color: var(--bg);
      background: var(--fg);
    }

    .transcript-entry.user .entry-role {
      color: var(--bg);
      background: var(--magenta);
    }

    .transcript-entry.tool_use .entry-role {
      color: var(--bg);
      background: var(--cyan);
    }

    .transcript-entry.tool_result .entry-role {
      color: var(--bg);
      background: var(--orange);
    }

    .transcript-entry .entry-time {
      color: var(--fg-dim);
      font-size: 10px;
    }

    .transcript-entry .entry-content {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.5;
      max-height: 300px;
      overflow-y: auto;
    }

    .transcript-entry.assistant .entry-content {
      color: var(--fg-bright);
    }

    .transcript-entry.user .entry-content {
      color: var(--magenta);
    }

    .transcript-entry .tool-name {
      color: var(--cyan);
      font-weight: bold;
    }

    .transcript-entry .tool-input {
      color: var(--fg-dim);
      font-size: 11px;
      margin-top: 4px;
      padding: 4px 6px;
      background: #000;
      max-height: 100px;
      overflow-y: auto;
    }

    .tabs {
      display: flex;
      gap: 0;
      margin-bottom: 15px;
      border-bottom: 1px solid var(--border);
    }

    .tab {
      padding: 8px 16px;
      cursor: pointer;
      color: var(--fg-dim);
      border: 1px solid transparent;
      border-bottom: none;
      margin-bottom: -1px;
      font-size: 12px;
    }

    .tab:hover {
      color: var(--fg);
    }

    .tab.active {
      color: var(--accent);
      border-color: var(--border);
      background: var(--bg);
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
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
    let sessionEvents = {};
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

    function truncatePath(path, maxLen = 35) {
      if (path.length <= maxLen) return path;
      return '...' + path.slice(-maxLen + 3);
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function truncate(text, maxLen = 100) {
      if (!text) return '';
      if (text.length <= maxLen) return text;
      return text.slice(0, maxLen) + '...';
    }

    function getModelFromEvents(events) {
      const startEvent = events.find(e => e.hookEvent === 'SessionStart' && e.data?.model);
      return startEvent?.data?.model || null;
    }

    function formatModel(model) {
      if (!model) return 'unknown';
      // claude-opus-4-5-20251101 -> opus-4-5
      const match = model.match(/claude-([^-]+-[^-]+)/);
      return match ? match[1] : model;
    }

    function renderEventDetail(event) {
      const data = event.data || {};

      switch (event.hookEvent) {
        case 'SessionStart':
          return \`
            <div class="event-detail">
              <span class="label">source:</span>
              <span class="source">\${escapeHtml(data.source || 'unknown')}</span>
              \${data.model ? '<br><span class="label">model:</span> <span class="value">' + escapeHtml(data.model) + '</span>' : ''}
            </div>
          \`;

        case 'UserPromptSubmit':
          return \`
            <div class="event-detail">
              <div class="prompt-text">\${escapeHtml(data.prompt || '')}</div>
            </div>
          \`;

        case 'PreToolUse':
          const preInput = data.tool_input || {};
          return \`
            <div class="event-detail">
              <span class="label">tool:</span>
              <span class="tool-name">\${escapeHtml(data.tool_name || '')}</span>
              \${preInput.command ? '<br><span class="label">cmd:</span> <span class="command">' + escapeHtml(preInput.command) + '</span>' : ''}
              \${preInput.description ? '<br><span class="label">desc:</span> <span class="value">' + escapeHtml(preInput.description) + '</span>' : ''}
              \${preInput.file_path ? '<br><span class="label">file:</span> <span class="value">' + escapeHtml(preInput.file_path) + '</span>' : ''}
              \${preInput.pattern ? '<br><span class="label">pattern:</span> <span class="value">' + escapeHtml(preInput.pattern) + '</span>' : ''}
            </div>
          \`;

        case 'PostToolUse':
          const postInput = data.tool_input || {};
          const response = data.tool_response || {};
          let output = '';
          if (typeof response === 'string') {
            output = response;
          } else if (response.stdout || response.stderr) {
            output = (response.stdout || '') + (response.stderr ? '\\n[stderr] ' + response.stderr : '');
          }
          return \`
            <div class="event-detail">
              <span class="label">tool:</span>
              <span class="tool-name">\${escapeHtml(data.tool_name || '')}</span>
              \${postInput.command ? '<br><span class="label">cmd:</span> <span class="command">' + escapeHtml(postInput.command) + '</span>' : ''}
              \${postInput.file_path ? '<br><span class="label">file:</span> <span class="value">' + escapeHtml(postInput.file_path) + '</span>' : ''}
              \${output ? '<div class="output">' + escapeHtml(truncate(output, 500)) + '</div>' : ''}
            </div>
          \`;

        case 'Stop':
          return \`
            <div class="event-detail">
              <span class="label">hook active:</span>
              <span class="value">\${data.stop_hook_active ? 'yes' : 'no'}</span>
            </div>
          \`;

        case 'Notification':
          return \`
            <div class="event-detail">
              <span class="notification-msg">\${escapeHtml(data.message || '')}</span>
              \${data.notification_type ? '<br><span class="label">type:</span> <span class="value">' + escapeHtml(data.notification_type) + '</span>' : ''}
            </div>
          \`;

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
        const res = await fetch(API_BASE + '/sessions/' + sessionId + '/events?limit=200');
        const events = await res.json();
        sessionEvents[sessionId] = events;
        return events;
      } catch (err) {
        console.error('Failed to fetch events:', err);
        return [];
      }
    }

    async function fetchTranscript(sessionId) {
      try {
        const res = await fetch(API_BASE + '/sessions/' + sessionId + '/transcript?limit=30');
        if (!res.ok) return [];
        return await res.json();
      } catch (err) {
        console.error('Failed to fetch transcript:', err);
        return [];
      }
    }

    function renderTranscriptEntry(entry) {
      const type = entry.type || 'unknown';
      const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '';

      if (type === 'assistant' && entry.message?.content) {
        const textContent = entry.message.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\\n');

        const toolUses = entry.message.content
          .filter(c => c.type === 'tool_use')
          .map(c => \`<div class="tool-name">\${escapeHtml(c.name || 'tool')}</div><div class="tool-input">\${escapeHtml(truncate(JSON.stringify(c.input, null, 2), 200))}</div>\`)
          .join('');

        if (!textContent && !toolUses) return '';

        return \`
          <div class="transcript-entry assistant">
            <div class="entry-header">
              <span class="entry-role">Claude</span>
              <span class="entry-time">\${timestamp}</span>
            </div>
            \${textContent ? '<div class="entry-content">' + escapeHtml(textContent) + '</div>' : ''}
            \${toolUses}
          </div>
        \`;
      }

      if (type === 'user' && entry.message?.content) {
        const textContent = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\\n');

        if (!textContent) return '';

        return \`
          <div class="transcript-entry user">
            <div class="entry-header">
              <span class="entry-role">User</span>
              <span class="entry-time">\${timestamp}</span>
            </div>
            <div class="entry-content">\${escapeHtml(textContent)}</div>
          </div>
        \`;
      }

      // Skip progress entries and other noise
      return '';
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

      const sorted = [...sessions].sort((a, b) => {
        if (a.status === 'active' && b.status !== 'active') return -1;
        if (a.status !== 'active' && b.status === 'active') return 1;
        return b.lastActivity - a.lastActivity;
      });

      list.innerHTML = sorted.map(s => {
        const events = sessionEvents[s.id] || [];
        const model = getModelFromEvents(events) || s.model;
        return \`
          <li class="session-item \${s.id === selectedSessionId ? 'selected' : ''}"
              data-id="\${s.id}"
              onclick="selectSession('\${s.id}')">
            <div class="id">\${s.id.slice(0, 8)}...</div>
            <div class="cwd">\${truncatePath(s.cwd)}</div>
            <div class="meta">
              <span class="badge \${s.status}">\${s.status}</span>
              <span>\${formatAge(s.lastActivity)}</span>
              <span>\${s.eventCount} events</span>
              <span class="model-name">\${formatModel(model)}</span>
            </div>
          </li>
        \`;
      }).join('');
    }

    async function selectSession(sessionId) {
      selectedSessionId = sessionId;
      renderSessionList();

      const session = sessions.find(s => s.id === sessionId);
      const [events, transcript] = await Promise.all([
        fetchSessionEvents(sessionId),
        fetchTranscript(sessionId)
      ]);

      renderDetailPanel(session, events, transcript);
    }

    function renderDetailPanel(session, events, transcript = []) {
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

      const model = getModelFromEvents(events) || session.model;

      const eventsHtml = events.length === 0
        ? '<div class="empty-state">No events yet</div>'
        : events.slice().reverse().map(e => \`
          <div class="event-item \${e.hookEvent}">
            <div class="event-header">
              <span class="time">\${formatTime(e.timestamp)}</span>
              <span class="type">\${e.hookEvent}</span>
            </div>
            \${renderEventDetail(e)}
          </div>
        \`).join('');

      const transcriptHtml = transcript.length === 0
        ? '<div class="empty-state">No transcript available</div>'
        : transcript.map(renderTranscriptEntry).filter(Boolean).join('');

      panel.innerHTML = \`
        <div class="detail-section">
          <h3>Session Info</h3>
          <dl class="detail-grid">
            <dt>ID</dt>
            <dd>\${session.id}</dd>
            <dt>Status</dt>
            <dd><span class="badge \${session.status}">\${session.status}</span></dd>
            <dt>CWD</dt>
            <dd>\${session.cwd}</dd>
            <dt>Model</dt>
            <dd>\${model || 'unknown'}</dd>
            <dt>Started</dt>
            <dd>\${new Date(session.startedAt).toLocaleString()}</dd>
            <dt>Last Activity</dt>
            <dd>\${formatAge(session.lastActivity)}</dd>
            <dt>Events</dt>
            <dd>\${session.eventCount}</dd>
          </dl>
        </div>

        <div class="tabs">
          <div class="tab active" onclick="switchTab('transcript')">Transcript</div>
          <div class="tab" onclick="switchTab('events')">Events</div>
        </div>

        <div id="tab-transcript" class="tab-content active transcript-section">
          \${transcriptHtml}
        </div>

        <div id="tab-events" class="tab-content event-log">
          \${eventsHtml}
        </div>
      \`;
    }

    function switchTab(tabName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

      document.querySelector(\`.tab[onclick*="\${tabName}"]\`).classList.add('active');
      document.getElementById('tab-' + tabName).classList.add('active');
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
          const [events, transcript] = await Promise.all([
            fetchSessionEvents(selectedSessionId),
            fetchTranscript(selectedSessionId)
          ]);
          renderDetailPanel(session, events, transcript);
        }
      }

      setTimeout(() => indicator.classList.remove('active'), 200);
    }

    refresh();
    refreshInterval = setInterval(refresh, 2000);

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
