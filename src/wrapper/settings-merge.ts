/**
 * Settings Merge Module
 * Reads user's Claude settings and injects hook configurations
 */

import { homedir } from "os";
import { join } from "path";

interface Hook {
  type: "command";
  command: string;
}

interface HookMatcher {
  matcher: string;
  hooks: Hook[];
}

interface ClaudeSettings {
  hooks?: {
    SessionStart?: HookMatcher[];
    UserPromptSubmit?: HookMatcher[];
    PreToolUse?: HookMatcher[];
    PostToolUse?: HookMatcher[];
    PostToolUseFailure?: HookMatcher[];
    Notification?: HookMatcher[];
    Stop?: HookMatcher[];
    SessionEnd?: HookMatcher[];
    SubagentStart?: HookMatcher[];
    SubagentStop?: HookMatcher[];
    PreCompact?: HookMatcher[];
    PermissionRequest?: HookMatcher[];
  };
  [key: string]: unknown;
}

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PermissionRequest",
] as const;

/**
 * Read user's existing Claude settings
 */
async function readUserSettings(): Promise<ClaudeSettings> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const file = Bun.file(settingsPath);

  if (await file.exists()) {
    try {
      return (await file.json()) as ClaudeSettings;
    } catch (error) {
      console.error(`Warning: Failed to parse ${settingsPath}:`, error);
      return {};
    }
  }

  return {};
}

/**
 * Create hook matcher for forwarding to local server
 */
function createHookMatcher(
  hookEvent: string,
  port: number,
  sessionId: string
): HookMatcher {
  // Use curl to POST hook data to our local server
  const command = `curl -s -X POST "http://127.0.0.1:${port}/hook/${hookEvent}" -H "Content-Type: application/json" -H "X-Session-Id: ${sessionId}" -d @-`;

  return {
    matcher: "", // Match all
    hooks: [
      {
        type: "command",
        command,
      },
    ],
  };
}

/**
 * Deep merge two objects, with second object taking precedence
 */
function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base } as T;

  for (const key in override) {
    const overrideValue = override[key];
    const baseValue = result[key];

    if (
      overrideValue &&
      typeof overrideValue === "object" &&
      !Array.isArray(overrideValue) &&
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      result[key] = deepMerge(
        baseValue as Record<string, unknown>,
        overrideValue as Record<string, unknown>
      ) as T[Extract<keyof T, string>];
    } else if (Array.isArray(overrideValue) && Array.isArray(baseValue)) {
      // For arrays (like hook matchers), prepend our hooks to preserve user's
      result[key] = [...overrideValue, ...baseValue] as T[Extract<keyof T, string>];
    } else if (overrideValue !== undefined) {
      result[key] = overrideValue as T[Extract<keyof T, string>];
    }
  }

  return result;
}

/**
 * Generate merged settings with hook injection
 */
export async function generateMergedSettings(
  sessionId: string,
  port: number
): Promise<ClaudeSettings> {
  const userSettings = await readUserSettings();

  // Create our hook configuration
  const ourHooks: ClaudeSettings["hooks"] = {};
  for (const event of HOOK_EVENTS) {
    ourHooks[event] = [createHookMatcher(event, port, sessionId)];
  }

  // Merge with user's settings (our hooks first, then user's)
  return deepMerge(userSettings, { hooks: ourHooks });
}

/**
 * Write merged settings to a temp file and return the path
 */
export async function writeMergedSettings(
  sessionId: string,
  port: number
): Promise<string> {
  const settings = await generateMergedSettings(sessionId, port);
  const settingsPath = `/tmp/rclaude-settings-${sessionId}.json`;

  await Bun.write(settingsPath, JSON.stringify(settings, null, 2));

  return settingsPath;
}

/**
 * Clean up the temp settings file
 */
export async function cleanupSettings(sessionId: string): Promise<void> {
  const settingsPath = `/tmp/rclaude-settings-${sessionId}.json`;
  try {
    await Bun.file(settingsPath).exists() &&
      (await Bun.$`rm ${settingsPath}`.quiet());
  } catch {
    // Ignore cleanup errors
  }
}
