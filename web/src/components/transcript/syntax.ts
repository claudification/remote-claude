/**
 * Shiki syntax highlighting - lazy-loaded singleton highlighter
 * Used by DiffView, WritePreview, ShellCommand for code highlighting
 */

// Lazy singleton highlighter
// biome-ignore lint/suspicious/noExplicitAny: shiki's HighlighterGeneric type is complex and internal
let highlighterPromise: Promise<any> | null = null

const EAGER_LANGS = [
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'shellscript',
  'html',
  'astro',
  'css',
  'json',
  'yaml',
  'markdown',
]

export function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki/bundle/web').then(m =>
      m.createHighlighter({
        themes: ['tokyo-night'],
        langs: EAGER_LANGS,
      }),
    )
  }
  return highlighterPromise
}

// Lazy-load a language into the highlighter if not already loaded
export async function ensureLang(lang: string): Promise<boolean> {
  const hl = await getHighlighter()
  const loaded = hl.getLoadedLanguages() as string[]
  if (loaded.includes(lang)) return true
  try {
    const mod = await import('shiki/bundle/web')
    const available = mod.bundledLanguagesInfo.map((l: { id: string }) => l.id)
    if (!available.includes(lang)) return false
    await hl.loadLanguage(lang)
    return true
  } catch {
    return false
  }
}

// File extension -> shiki language id
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sass: 'sass',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'mdx',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  php: 'php',
  r: 'r',
  coffee: 'coffee',
  pug: 'pug',
  hbs: 'handlebars',
}

export function langFromPath(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext ? EXT_TO_LANG[ext] : undefined
}
