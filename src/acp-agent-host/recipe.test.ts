import { describe, expect, it } from 'bun:test'
import { parseAgentCmd, parseHostConfig, parseRecipe, RecipeParseError } from './recipe'

describe('parseAgentCmd', () => {
  it('parses a JSON array of strings', () => {
    expect(parseAgentCmd('["opencode","acp"]')).toEqual(['opencode', 'acp'])
  })
  it('throws when missing', () => {
    expect(() => parseAgentCmd(undefined)).toThrow(RecipeParseError)
  })
  it('throws on invalid JSON', () => {
    expect(() => parseAgentCmd('not json')).toThrow(/invalid JSON/)
  })
  it('throws on non-array JSON', () => {
    expect(() => parseAgentCmd('"opencode"')).toThrow(/non-empty array/)
  })
  it('throws on empty array', () => {
    expect(() => parseAgentCmd('[]')).toThrow(/non-empty array/)
  })
  it('throws when any element is not a string', () => {
    expect(() => parseAgentCmd('["a", 2]')).toThrow(/non-empty array/)
  })
  it('throws on empty string element', () => {
    expect(() => parseAgentCmd('["a", ""]')).toThrow(/non-empty array/)
  })
})

describe('parseRecipe', () => {
  it('returns sensible defaults when only the cmd is set', () => {
    const r = parseRecipe({ ACP_AGENT_CMD_JSON: '["opencode","acp"]' })
    expect(r.agentCmd).toEqual(['opencode', 'acp'])
    expect(r.agentName).toBe('unknown')
    expect(r.mcpServerName).toBe('claudwerk')
    expect(r.initialModel).toBeNull()
    expect(r.toolPermission).toBe('safe')
  })

  it('passes through agentName and initialModel', () => {
    const r = parseRecipe({
      ACP_AGENT_NAME: 'opencode',
      ACP_AGENT_CMD_JSON: '["opencode","acp"]',
      ACP_AGENT_INITIAL_MODEL: 'openrouter/anthropic/claude-haiku-4.5',
    })
    expect(r.agentName).toBe('opencode')
    expect(r.initialModel).toBe('openrouter/anthropic/claude-haiku-4.5')
  })

  it('normalizes tier values', () => {
    expect(parseRecipe({ ACP_AGENT_CMD_JSON: '["x"]', ACP_TOOL_PERMISSION: 'none' }).toolPermission).toBe('none')
    expect(parseRecipe({ ACP_AGENT_CMD_JSON: '["x"]', ACP_TOOL_PERMISSION: 'full' }).toolPermission).toBe('full')
    expect(parseRecipe({ ACP_AGENT_CMD_JSON: '["x"]', ACP_TOOL_PERMISSION: 'bogus' }).toolPermission).toBe('safe')
  })

  it('honors a custom mcpServerName', () => {
    expect(parseRecipe({ ACP_AGENT_CMD_JSON: '["x"]', ACP_AGENT_MCP_NAME: 'custom' }).mcpServerName).toBe('custom')
  })
})

describe('parseHostConfig', () => {
  const baseEnv = {
    ACP_AGENT_NAME: 'opencode',
    ACP_AGENT_CMD_JSON: '["opencode","acp"]',
    RCLAUDE_CONVERSATION_ID: 'conv-123',
  }
  const DEFAULT_BROKER = 'ws://localhost:9999'

  it('throws when RCLAUDE_CONVERSATION_ID is missing', () => {
    const { RCLAUDE_CONVERSATION_ID, ...rest } = baseEnv
    expect(() => parseHostConfig(rest, DEFAULT_BROKER)).toThrow(/RCLAUDE_CONVERSATION_ID/)
  })

  it('falls back to the default broker when not set', () => {
    const cfg = parseHostConfig(baseEnv, DEFAULT_BROKER)
    expect(cfg.brokerUrl).toBe(DEFAULT_BROKER)
  })

  it('uses RCLAUDE_BROKER when set', () => {
    const cfg = parseHostConfig({ ...baseEnv, RCLAUDE_BROKER: 'wss://broker.example.com' }, DEFAULT_BROKER)
    expect(cfg.brokerUrl).toBe('wss://broker.example.com')
  })

  it('forwards optional title / description / resumeSessionId / debug', () => {
    const cfg = parseHostConfig({
      ...baseEnv,
      CLAUDWERK_CONVERSATION_NAME: 'my-conv',
      CLAUDWERK_CONVERSATION_DESCRIPTION: 'desc',
      ACP_RESUME_SESSION_ID: 'ses_abc',
      ACP_HOST_DEBUG: '1',
    }, DEFAULT_BROKER)
    expect(cfg.conversationTitle).toBe('my-conv')
    expect(cfg.conversationDescription).toBe('desc')
    expect(cfg.resumeSessionId).toBe('ses_abc')
    expect(cfg.debug).toBe(true)
  })
})
