// Type declarations for shiki individual lang/theme imports via ./* wildcard export
declare module 'shiki/langs/*' {
  import type { LanguageRegistration } from 'shiki/core'
  const lang: LanguageRegistration[]
  export default lang
}

declare module 'shiki/themes/*' {
  import type { ThemeRegistration } from 'shiki/core'
  const theme: ThemeRegistration
  export default theme
}
