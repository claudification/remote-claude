/**
 * Shiki syntax highlighting - static imports for core + eager langs,
 * lazy imports only for rare languages.
 */

import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import langAstro from 'shiki/langs/astro'
import langCss from 'shiki/langs/css'
import langHtml from 'shiki/langs/html'
import langJavascript from 'shiki/langs/javascript'
import langJson from 'shiki/langs/json'
import langJsx from 'shiki/langs/jsx'
import langMarkdown from 'shiki/langs/markdown'
import langShellscript from 'shiki/langs/shellscript'
import langTsx from 'shiki/langs/tsx'
import langTypescript from 'shiki/langs/typescript'
import langYaml from 'shiki/langs/yaml'
import tokyoNight from 'shiki/themes/tokyo-night'

const EAGER_LANGS = [
  langJavascript,
  langTypescript,
  langTsx,
  langJsx,
  langShellscript,
  langHtml,
  langAstro,
  langCss,
  langJson,
  langYaml,
  langMarkdown,
].flat()

// Lazy singleton highlighter
let highlighterPromise: Promise<HighlighterCore> | null = null

// Languages available for lazy loading (less common)
const LAZY_LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  python: () => import('shiki/langs/python'),
  ruby: () => import('shiki/langs/ruby'),
  rust: () => import('shiki/langs/rust'),
  go: () => import('shiki/langs/go'),
  java: () => import('shiki/langs/java'),
  c: () => import('shiki/langs/c'),
  cpp: () => import('shiki/langs/cpp'),
  csharp: () => import('shiki/langs/csharp'),
  scss: () => import('shiki/langs/scss'),
  less: () => import('shiki/langs/less'),
  sass: () => import('shiki/langs/sass'),
  vue: () => import('shiki/langs/vue'),
  svelte: () => import('shiki/langs/svelte'),
  jsonc: () => import('shiki/langs/jsonc'),
  json5: () => import('shiki/langs/json5'),
  xml: () => import('shiki/langs/xml'),
  toml: () => import('shiki/langs/toml'),
  mdx: () => import('shiki/langs/mdx'),
  sql: () => import('shiki/langs/sql'),
  graphql: () => import('shiki/langs/graphql'),
  php: () => import('shiki/langs/php'),
  r: () => import('shiki/langs/r'),
  coffee: () => import('shiki/langs/coffee'),
  pug: () => import('shiki/langs/pug'),
  handlebars: () => import('shiki/langs/handlebars'),
  dockerfile: () => import('shiki/langs/dockerfile'),
  swift: () => import('shiki/langs/swift'),
  kotlin: () => import('shiki/langs/kotlin'),
  lua: () => import('shiki/langs/lua'),
}

// All known language IDs (eager + lazy)
const ALL_LANGS = new Set([
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
  ...Object.keys(LAZY_LANG_LOADERS),
])

export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [tokyoNight],
      langs: EAGER_LANGS,
      engine: createJavaScriptRegexEngine(),
    })
  }
  return highlighterPromise
}

// Lazy-load a language into the highlighter if not already loaded
export async function ensureLang(lang: string): Promise<boolean> {
  if (!ALL_LANGS.has(lang)) return false
  const hl = await getHighlighter()
  const loaded = hl.getLoadedLanguages() as string[]
  if (loaded.includes(lang)) return true
  const loader = LAZY_LANG_LOADERS[lang]
  if (!loader) return false
  try {
    const mod = (await loader()) as { default: unknown[] }
    await hl.loadLanguage(...(mod.default as Parameters<typeof hl.loadLanguage>))
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
  cs: 'csharp',
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
  dockerfile: 'dockerfile',
  swift: 'swift',
  kt: 'kotlin',
  lua: 'lua',
}

export function langFromPath(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext ? EXT_TO_LANG[ext] : undefined
}
