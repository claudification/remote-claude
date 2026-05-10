import { describe, expect, it } from 'bun:test'
import {
  brokerMcpUrlFromWs,
  buildOpenCodeConfig,
  DEFAULT_OPENCODE_TOOL_PERMISSION,
  normalizeTier,
  OPENCODE_ALL_TOOLS,
  OPENCODE_MCP_SERVER_NAME,
  OPENCODE_SAFE_TOOLS,
  shouldSkipPermissions,
} from './opencode-config'

describe('buildOpenCodeConfig', () => {
  it('returns null for the full tier (caller passes --dangerously-skip-permissions)', () => {
    expect(buildOpenCodeConfig('full')).toBeNull()
  })

  it('disables every known tool for the none tier', () => {
    const cfg = buildOpenCodeConfig('none')
    expect(cfg).not.toBeNull()
    if (!cfg) return
    expect(cfg.tools).toBeDefined()
    for (const t of OPENCODE_ALL_TOOLS) {
      expect(cfg.tools?.[t]).toBe(false)
      expect(cfg.permission?.[t]).toBe('deny')
    }
  })

  it('enables only the safe tools for the safe tier and denies the rest', () => {
    const cfg = buildOpenCodeConfig('safe')
    expect(cfg).not.toBeNull()
    if (!cfg) return
    const safeSet = new Set<string>(OPENCODE_SAFE_TOOLS)
    for (const t of OPENCODE_ALL_TOOLS) {
      if (safeSet.has(t)) {
        expect(cfg.tools?.[t]).toBe(true)
        expect(cfg.permission?.[t]).toBe('allow')
      } else {
        expect(cfg.tools?.[t]).toBe(false)
        expect(cfg.permission?.[t]).toBe('deny')
      }
    }
  })

  it('safe tier explicitly disables bash, write, and edit', () => {
    const cfg = buildOpenCodeConfig('safe')
    expect(cfg?.tools?.bash).toBe(false)
    expect(cfg?.tools?.write).toBe(false)
    expect(cfg?.tools?.edit).toBe(false)
    expect(cfg?.permission?.bash).toBe('deny')
    expect(cfg?.permission?.write).toBe('deny')
    expect(cfg?.permission?.edit).toBe('deny')
  })

  it('emits the official $schema field so editor tooling validates it', () => {
    expect(buildOpenCodeConfig('safe')?.$schema).toBe('https://opencode.ai/config.json')
    expect(buildOpenCodeConfig('none')?.$schema).toBe('https://opencode.ai/config.json')
  })
})

describe('buildOpenCodeConfig MCP bridge', () => {
  const URL = 'https://broker.example.com/mcp'
  const SECRET = 'sentinel-secret-xyz'

  it('omits the mcp block when no options are passed', () => {
    expect(buildOpenCodeConfig('safe')?.mcp).toBeUndefined()
    expect(buildOpenCodeConfig('none')?.mcp).toBeUndefined()
  })

  it('omits the mcp block when only the URL is given (no secret)', () => {
    expect(buildOpenCodeConfig('safe', { brokerMcpUrl: URL })?.mcp).toBeUndefined()
    expect(buildOpenCodeConfig('none', { brokerMcpUrl: URL })?.mcp).toBeUndefined()
  })

  it('omits the mcp block when only the secret is given (no URL)', () => {
    expect(buildOpenCodeConfig('safe', { secret: SECRET })?.mcp).toBeUndefined()
  })

  it('emits a remote claudwerk entry when both URL and secret are present', () => {
    const cfg = buildOpenCodeConfig('safe', { brokerMcpUrl: URL, secret: SECRET })
    expect(cfg?.mcp?.[OPENCODE_MCP_SERVER_NAME]).toEqual({
      type: 'remote',
      url: URL,
      headers: { Authorization: `Bearer ${SECRET}` },
      enabled: true,
    })
  })

  it('returns null for the full tier without MCP options (no config file needed)', () => {
    expect(buildOpenCodeConfig('full')).toBeNull()
    expect(buildOpenCodeConfig('full', {})).toBeNull()
    expect(buildOpenCodeConfig('full', { brokerMcpUrl: URL })).toBeNull()
  })

  it('returns a config WITH mcp but WITHOUT tools/permission for full + MCP', () => {
    const cfg = buildOpenCodeConfig('full', { brokerMcpUrl: URL, secret: SECRET })
    expect(cfg).not.toBeNull()
    expect(cfg?.tools).toBeUndefined()
    expect(cfg?.permission).toBeUndefined()
    expect(cfg?.mcp?.[OPENCODE_MCP_SERVER_NAME]).toBeDefined()
  })

  it('preserves the tier tools/permission alongside the mcp block', () => {
    const cfg = buildOpenCodeConfig('safe', { brokerMcpUrl: URL, secret: SECRET })
    expect(cfg?.tools?.bash).toBe(false)
    expect(cfg?.tools?.read).toBe(true)
    expect(cfg?.permission?.bash).toBe('deny')
    expect(cfg?.mcp?.[OPENCODE_MCP_SERVER_NAME]?.url).toBe(URL)
  })
})

describe('brokerMcpUrlFromWs', () => {
  it('rewrites ws:// to http:// and replaces the path with /mcp', () => {
    expect(brokerMcpUrlFromWs('ws://localhost:9999')).toBe('http://localhost:9999/mcp')
    expect(brokerMcpUrlFromWs('ws://localhost:9999/')).toBe('http://localhost:9999/mcp')
    expect(brokerMcpUrlFromWs('ws://localhost:9999/agent?token=x')).toBe('http://localhost:9999/mcp')
  })

  it('rewrites wss:// to https://', () => {
    expect(brokerMcpUrlFromWs('wss://broker.example.com')).toBe('https://broker.example.com/mcp')
    expect(brokerMcpUrlFromWs('wss://broker.example.com:443/foo')).toBe('https://broker.example.com/mcp')
  })

  it('passes through http:// and https:// inputs (already HTTP)', () => {
    expect(brokerMcpUrlFromWs('http://localhost:9999')).toBe('http://localhost:9999/mcp')
    expect(brokerMcpUrlFromWs('https://broker.example.com/anything')).toBe('https://broker.example.com/mcp')
  })

  it('returns null for missing or unparseable inputs', () => {
    expect(brokerMcpUrlFromWs(undefined)).toBeNull()
    expect(brokerMcpUrlFromWs('')).toBeNull()
    expect(brokerMcpUrlFromWs('not a url')).toBeNull()
    expect(brokerMcpUrlFromWs('ftp://example.com')).toBeNull()
  })
})

describe('shouldSkipPermissions', () => {
  it('is true only for the full tier', () => {
    expect(shouldSkipPermissions('full')).toBe(true)
    expect(shouldSkipPermissions('safe')).toBe(false)
    expect(shouldSkipPermissions('none')).toBe(false)
  })
})

describe('normalizeTier', () => {
  it('passes through valid tiers', () => {
    expect(normalizeTier('none')).toBe('none')
    expect(normalizeTier('safe')).toBe('safe')
    expect(normalizeTier('full')).toBe('full')
  })

  it('falls back to the default for invalid inputs', () => {
    expect(normalizeTier(undefined)).toBe(DEFAULT_OPENCODE_TOOL_PERMISSION)
    expect(normalizeTier(null)).toBe(DEFAULT_OPENCODE_TOOL_PERMISSION)
    expect(normalizeTier('')).toBe(DEFAULT_OPENCODE_TOOL_PERMISSION)
    expect(normalizeTier('bogus')).toBe(DEFAULT_OPENCODE_TOOL_PERMISSION)
    expect(normalizeTier(42)).toBe(DEFAULT_OPENCODE_TOOL_PERMISSION)
  })

  it('default tier is safe (least privilege)', () => {
    expect(DEFAULT_OPENCODE_TOOL_PERMISSION).toBe('safe')
  })
})
