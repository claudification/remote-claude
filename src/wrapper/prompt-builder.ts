/**
 * System Prompt Builder
 * Generates the system prompt additions for rclaude-specific behavior
 * (attached files, notifications, MCP tools, channel, headless instructions).
 */

export interface PromptOptions {
  localServerPort: number
  channelEnabled: boolean
  headless: boolean
}

export function buildSystemPrompt(opts: PromptOptions): string {
  const { localServerPort, channelEnabled, headless } = opts

  return [
    '# Attached Files (rclaude)',
    '',
    'When the user sends a message containing markdown image or file links like `![filename](https://...)` or `[filename](https://...)`,',
    'these are files attached via the remote dashboard. Handle them based on file type:',
    '',
    '- **Images** (.png, .jpg, .jpeg, .gif, .webp, .svg): Download with `curl -sL "<url>" -o /tmp/<filename>`, then use the Read tool to view the downloaded file.',
    '- **Text/code files** (.txt, .md, .json, .csv, .xml, .yaml, .yml, .toml, .ts, .js, .py, etc.): Use `curl -sL "<url>"` to fetch and read the content directly.',
    '- **PDFs** (.pdf): Download with `curl -sL "<url>" -o /tmp/<filename>`, then use the Read tool with the pages parameter.',
    '',
    'Always download and process these files - do not just acknowledge the links. The user expects you to see and work with the file contents.',
    '',
    '# Notifications (rclaude)',
    '',
    "You can send push notifications to the user's devices (phone, browser) via the rclaude notification endpoint.",
    'Use this when the user asks to be notified, or when a long-running task completes and the user might not be watching.',
    '',
    '```bash',
    `curl -s -X POST http://127.0.0.1:${localServerPort}/notify -H "Content-Type: application/json" -d '{"message": "Your task is done!", "title": "Optional title"}'`,
    '```',
    '',
    '- `message` (required): The notification body text',
    '- `title` (optional): Notification title (defaults to project name)',
    '',
    "This sends a real push notification to the user's phone/browser AND shows a toast in the dashboard.",
    '',
    '# MCP Tools (rclaude)',
    '',
    '**Available MCP tools (rclaude server):**',
    "- `mcp__rclaude__notify` - Send a push notification to the user's devices (phone, browser)",
    '- `mcp__rclaude__share_file` - Upload a local file and get a public URL for the dashboard user',
    '',
    'Prefer the MCP `notify` tool over the curl endpoint when the channel is active.',
    'Use `share_file` to share screenshots, images, build artifacts, or any file the user needs to see.',
    '# Project Board (rclaude)',
    '',
    'Use `mcp__rclaude__project_list` to list project tasks from the board.',
    'Tasks are markdown files in `.rclaude/project/{status}/` with YAML frontmatter.',
    'Status folders: `open/`, `in-progress/`, `done/`, `archived/`.',
    'To change status: `mcp__rclaude__project_set_status` with id (filename without .md) and target status.',
    'To edit: read and write the .md file directly (update frontmatter + body).',
    'Frontmatter: title, priority (high/medium/low), tags [...], refs [...], created (ISO).',
    'Changes are auto-pushed to the dashboard project board via file watcher.',
    '',
    ...(channelEnabled
      ? [
          '',
          '# MCP Channel (rclaude)',
          '',
          'This session has an active MCP channel connection to the rclaude remote dashboard.',
          'Messages from the dashboard arrive as `<channel source="rclaude">` -- treat them as regular user input.',
          'The user may be on their phone or another device, not at the terminal.',
          '',
          '# Inter-Session Communication (rclaude)',
          '',
          'You can communicate with other active Claude Code sessions that have channels enabled:',
          '- `mcp__rclaude__list_sessions` - discover live sessions (only shows channel-capable sessions)',
          '- `mcp__rclaude__send_message` - send a message to another session (first contact requires user approval via dashboard)',
          '',
          'Messages from other sessions arrive as `<channel sender="session">`. They include:',
          '- `from_session` / `from_project`: who sent it',
          '- `intent`: request (they need something), response (answering you), notify (FYI), progress (status update)',
          '- `conversation_id`: include this in replies to maintain thread context',
          '',
          'Session linking is managed by the user via the dashboard -- you cannot approve or block sessions.',
          'Always include conversation_id when replying to maintain context threading.',
          '',
          '**IMPORTANT: When you receive a `<channel sender="session">` message and want to reply,',
          'ALWAYS use `mcp__rclaude__send_message` -- NEVER the built-in `SendMessage` tool.**',
          'The built-in `SendMessage` writes to a local file inbox that is invisible to the user',
          'and the dashboard. `mcp__rclaude__send_message` routes through the concentrator where',
          'the user can see, approve, and track all inter-session messages. This applies to ALL',
          'inter-session replies, regardless of how the original message arrived.',
        ]
      : []),
    // Headless conduit messaging
    ...(headless
      ? [
          '',
          '# Headless Mode',
          '',
          'This session is running in **headless mode** (no terminal, structured I/O).',
          'User messages arrive as plain text.',
          'Inter-session messages from other Claude Code sessions arrive wrapped in `<channel>` tags:',
          '',
          '```',
          '<channel sender="session" from_project="other-project" intent="request" conversation_id="conv_xyz">',
          'Message from another session',
          '</channel>',
          '```',
          '',
          'Treat these as requests from other AI sessions. Include conversation_id when replying.',
        ]
      : []),
  ].join('\n')
}
