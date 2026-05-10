export interface ProviderPreset {
  id: string
  name: string
  url: string
  defaultModel?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com', defaultModel: 'gpt-4o' },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api', defaultModel: 'anthropic/claude-sonnet-4' },
  {
    id: 'together',
    name: 'Together AI',
    url: 'https://api.together.xyz',
    defaultModel: 'meta-llama/Llama-3-70b-chat-hf',
  },
  { id: 'groq', name: 'Groq', url: 'https://api.groq.com/openai', defaultModel: 'llama-3.1-70b-versatile' },
  { id: 'fireworks', name: 'Fireworks AI', url: 'https://api.fireworks.ai/inference' },
  { id: 'mistral', name: 'Mistral', url: 'https://api.mistral.ai', defaultModel: 'mistral-large-latest' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
  { id: 'ollama', name: 'Ollama (local)', url: 'http://localhost:11434' },
  { id: 'lmstudio', name: 'LM Studio (local)', url: 'http://localhost:1234' },
  { id: 'custom', name: 'Custom', url: '' },
]

export function findPresetByUrl(url: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.id !== 'custom' && p.url === url)
}
