/**
 * System Prompt Builder
 * Generates the system prompt additions for rclaude-specific behavior
 * (attached files, notifications, MCP tools, channel, headless instructions).
 */

export interface PromptIdentity {
  ccSessionId: string
  conversationId: string
  cwd: string
  configuredModel?: string
  headless: boolean
}

export interface PromptOptions {
  channelEnabled: boolean
  headless: boolean
  identity?: PromptIdentity
}

export function buildSystemPrompt(opts: PromptOptions): string {
  const { channelEnabled, headless, identity } = opts

  return [
    ...(identity
      ? [
          '# Session Identity (rclaude)',
          '',
          `- **CC Session ID:** \`${identity.ccSessionId}\``,
          `- **Conversation ID:** \`${identity.conversationId}\``,
          `- **CWD:** \`${identity.cwd}\``,
          ...(identity.configuredModel ? [`- **Model:** \`${identity.configuredModel}\``] : []),
          `- **Backend:** ${identity.headless ? 'headless' : 'PTY'}`,
          '',
          'Use `mcp__rclaude__whoami` for full identity details including versions and git info.',
          '',
        ]
      : []),
    '# Attached Files (rclaude)',
    '',
    'When the user sends a message containing markdown image or file links like `![filename](https://...)` or `[filename](https://...)`,',
    'these are files attached via the remote dashboard. Handle them based on file type:',
    '',
    '- **Images** (.png, .jpg, .jpeg, .gif, .webp, .svg): Download with `curl -sL "<url>" -o /tmp/<filename>`, then use REPL `cat(\'/tmp/<filename>\')` to view the image contents. The REPL cat() function supports image files natively.',
    '- **Text/code files** (.txt, .md, .json, .csv, .xml, .yaml, .yml, .toml, .ts, .js, .py, etc.): Use `curl -sL "<url>"` to fetch and read the content directly.',
    '- **PDFs** (.pdf): Download with `curl -sL "<url>" -o /tmp/<filename>`, then use REPL `cat(\'/tmp/<filename>\')` to read the PDF contents.',
    '',
    'Always download and process these files - do not just acknowledge the links. The user expects you to see and work with the file contents.',
    '',
    '# MCP Tools (rclaude)',
    '',
    '**Available MCP tools (rclaude server):**',
    "- `mcp__rclaude__notify` - Send a push notification to the user's devices (phone, browser)",
    '- `mcp__rclaude__share_file` - Upload a local file and get a public URL for the dashboard user',
    '',
    'Use `notify` when the user asks to be notified, or when a long-running task completes and the user might not be watching.',
    'Use `share_file` to share screenshots, images, build artifacts, or any file the user needs to see.',
    '# Project Board (rclaude)',
    '',
    'Use `mcp__rclaude__project_list` to list project tasks from the board.',
    'Tasks are markdown files in `.rclaude/project/{status}/` with YAML frontmatter.',
    'Status folders: `inbox/`, `open/`, `in-progress/`, `in-review/`, `done/`, `archived/`.',
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
          '## Session Addressing',
          '',
          'Each session has a stable ID returned by `list_sessions`. When a project directory has a single session,',
          'the ID is a bare slug (e.g. `rclaude`). When multiple sessions share a project directory, each gets a',
          'compound ID: `project:session-name` (e.g. `rclaude:fuzzy-rabbit`, `rclaude:insande-walrus`).',
          'Always use the exact ID from `list_sessions` when calling `send_message` or other tools.',
          'Bare IDs are rejected as ambiguous when multiple live sessions exist at the same project.',
          'Each entry also includes a `project` field for grouping context.',
          '',
          'Messages from other sessions arrive as `<channel sender="session">`. They include:',
          '- `from_session`: **the routable sender ID. Pass this exact value as `to` when replying** --',
          '  it is guaranteed to match what `list_sessions` would return for that session (bare or compound).',
          '- `from_project`: project-level grouping slug (informational only, NOT always routable).',
          '- `intent`: request (they need something), response (answering you), notify (FYI), progress (status update)',
          '- `conversation_id`: include this in replies to maintain thread context',
          '',
          'Session linking is managed by the user via the dashboard -- you cannot approve or block sessions.',
          'Always include conversation_id when replying to maintain context threading.',
          '',
          '**IMPORTANT: When you receive a `<channel sender="session">` message and want to reply,',
          'ALWAYS use `mcp__rclaude__send_message` -- NEVER the built-in `SendMessage` tool.**',
          'The built-in `SendMessage` writes to a local file inbox that is invisible to the user',
          'and the dashboard. `mcp__rclaude__send_message` routes through the broker where',
          'the user can see, approve, and track all inter-session messages. This applies to ALL',
          'inter-session communication, regardless of how the original message arrived.',
          '',
          '**NEVER use the built-in `SendMessage` tool for ANY purpose.** It is blocked by hook.',
          'For ALL inter-session messaging (initiating, replying, notifying), use `mcp__rclaude__send_message`.',
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
          '<channel sender="session" from_session="other-project" from_project="other-project" intent="request" conversation_id="conv_xyz">',
          'Message from another session',
          '</channel>',
          '```',
          '',
          'To reply, pass the exact `from_session` value as `to` in `mcp__rclaude__send_message` --',
          'it is the routable sender ID (bare slug or compound `project:session-name`).',
          'Include `conversation_id` to maintain thread context.',
          '',
          '**NEVER use the built-in `SendMessage` tool.** It writes to a local file inbox that nobody reads.',
          'For ALL inter-session messaging, use `mcp__rclaude__send_message` instead.',
        ]
      : []),
  ].join('\n')
}
