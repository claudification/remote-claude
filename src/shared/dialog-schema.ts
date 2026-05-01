/**
 * Dialog MCP Tool - JSON Schema & Types
 *
 * Declarative UI system for rich user interactions via MCP channel.
 * Replaces AskUserQuestion (disabled when channels are active).
 *
 * Claude sends a JSON layout, dashboard renders it as a modal,
 * user interacts, result flows back as a single structured response.
 */

// ─── Design Tokens ─────────────────────────────────────────────────

export type DialogColor = 'primary' | 'secondary' | 'muted' | 'accent' | 'destructive' | 'success' | 'warning' | 'info'
export type ButtonVariant = 'default' | 'primary' | 'outline' | 'ghost'
export type ButtonIntent = 'neutral' | 'destructive' | 'success'
export type AlertIntent = 'info' | 'warning' | 'error' | 'success'

// ─── Component Types ───────────────────────────────────────────────

// Content components (display only)

export interface MarkdownComponent {
  type: 'Markdown'
  content?: string // inline markdown text
  file?: string // path to a markdown/text file (resolved by wrapper, mutually exclusive with content)
  color?: DialogColor
}

export interface DiagramComponent {
  type: 'Diagram'
  content: string
}

export interface ImageComponent {
  type: 'Image'
  url: string
  alt?: string
}

export interface AlertComponent {
  type: 'Alert'
  intent?: AlertIntent
  content: string
}

export interface DividerComponent {
  type: 'Divider'
}

// Input components (produce result data, keyed by `id`)

export interface OptionItem {
  value: string
  label: string
  description?: string
}

export interface OptionsComponent {
  type: 'Options'
  id: string
  label?: string
  multi?: boolean
  required?: boolean
  default?: string | string[]
  options: OptionItem[]
}

export interface TextInputComponent {
  type: 'TextInput'
  id: string
  label?: string
  placeholder?: string
  required?: boolean
  multiline?: boolean
  default?: string
  allowAttachment?: boolean
}

export interface ImagePickerImage {
  value: string
  url: string
  label?: string
}

export interface ImagePickerComponent {
  type: 'ImagePicker'
  id: string
  label?: string
  multi?: boolean
  allowUpload?: boolean
  images: ImagePickerImage[]
}

export interface ToggleComponent {
  type: 'Toggle'
  id: string
  label: string
  default?: boolean
}

export interface SliderComponent {
  type: 'Slider'
  id: string
  label?: string
  min?: number
  max?: number
  step?: number
  default?: number
}

// Action component

export interface ButtonComponent {
  type: 'Button'
  id: string
  label: string
  variant?: ButtonVariant
  intent?: ButtonIntent
}

// Layout components (structural, contain children)

export interface StackComponent {
  type: 'Stack'
  direction?: 'vertical' | 'horizontal'
  children: DialogComponent[]
}

export interface GridComponent {
  type: 'Grid'
  columns?: number
  children: DialogComponent[]
}

export interface GroupComponent {
  type: 'Group'
  label: string
  collapsed?: boolean
  children: DialogComponent[]
}

// ─── Component Union ───────────────────────────────────────────────

export type DialogComponent =
  | MarkdownComponent
  | DiagramComponent
  | ImageComponent
  | AlertComponent
  | DividerComponent
  | OptionsComponent
  | TextInputComponent
  | ImagePickerComponent
  | ToggleComponent
  | SliderComponent
  | ButtonComponent
  | StackComponent
  | GridComponent
  | GroupComponent

// ─── Page & Layout ─────────────────────────────────────────────────

export interface DialogPage {
  label: string
  body: DialogComponent[]
}

export interface DialogLayout {
  title: string
  description?: string
  timeout?: number // seconds, default 300, min 10, max 3600
  submitLabel?: string // default 'Submit'
  cancelLabel?: string // default 'Cancel'
  // Mutually exclusive: single-page (body) or multi-page (pages)
  body?: DialogComponent[]
  pages?: DialogPage[]
}

// ─── Result Schema ─────────────────────────────────────────────────

export interface DialogResult {
  [key: string]: unknown
  _action: string // 'submit' or custom button id
  _timeout: boolean
  _cancelled: boolean
}

// ─── WS Message Types ──────────────────────────────────────────────

/** Wrapper -> Broker: show dialog to dashboard */
export interface DialogShow {
  type: 'dialog_show'
  sessionId: string
  dialogId: string // unique per dialog invocation
  layout: DialogLayout
}

/** Dashboard -> Broker -> Wrapper: user submitted/cancelled/timed out */
export interface DialogResponse {
  type: 'dialog_result'
  sessionId: string
  dialogId: string
  result: DialogResult
}

/** Wrapper -> Broker -> Control Panel: dismiss active dialog */
export interface DialogDismiss {
  type: 'dialog_dismiss'
  sessionId: string
  dialogId: string
}

// ─── Validation ────────────────────────────────────────────────────

const VALID_COMPONENT_TYPES = new Set([
  'Markdown',
  'Diagram',
  'Image',
  'Alert',
  'Divider',
  'Options',
  'TextInput',
  'ImagePicker',
  'Toggle',
  'Slider',
  'Button',
  'Stack',
  'Grid',
  'Group',
])

const INPUT_COMPONENT_TYPES = new Set(['Options', 'TextInput', 'ImagePicker', 'Toggle', 'Slider', 'Button'])

/** Validate an DialogLayout, returns array of error messages (empty = valid) */
export function validateDialogLayout(layout: unknown): string[] {
  const errors: string[] = []
  if (!layout || typeof layout !== 'object') {
    return ['Layout must be an object']
  }

  const l = layout as Record<string, unknown>
  if (typeof l.title !== 'string' || !l.title) {
    errors.push('title is required and must be a non-empty string')
  }

  if (l.timeout !== undefined) {
    if (typeof l.timeout !== 'number' || l.timeout < 10 || l.timeout > 3600) {
      errors.push('timeout must be a number between 10 and 3600')
    }
  }

  const hasBody = Array.isArray(l.body)
  const hasPages = Array.isArray(l.pages)

  if (!hasBody && !hasPages) {
    errors.push('Either "body" or "pages" is required')
  } else if (hasBody && hasPages) {
    errors.push('Provide either "body" or "pages", not both')
  }

  if (hasBody) {
    const body = l.body as unknown[]
    if (body.length === 0) errors.push('body must have at least one component')
    const ids = new Set<string>()
    for (const comp of body) {
      validateComponent(comp, errors, ids, 0)
    }
  }

  if (hasPages) {
    const pages = l.pages as unknown[]
    if (pages.length === 0) errors.push('pages must have at least one page')
    const ids = new Set<string>()
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i] as Record<string, unknown>
      if (typeof page?.label !== 'string') {
        errors.push(`pages[${i}].label is required`)
      }
      if (!Array.isArray(page?.body) || (page.body as unknown[]).length === 0) {
        errors.push(`pages[${i}].body must be a non-empty array`)
      } else {
        for (const comp of page.body as unknown[]) {
          validateComponent(comp, errors, ids, 0)
        }
      }
    }
  }

  return errors
}

const MAX_NESTING = 4

function validateComponent(comp: unknown, errors: string[], ids: Set<string>, depth: number): void {
  if (!comp || typeof comp !== 'object') {
    errors.push('Component must be an object')
    return
  }

  const c = comp as Record<string, unknown>
  const type = c.type as string
  if (!VALID_COMPONENT_TYPES.has(type)) {
    errors.push(`Unknown component type: "${type}"`)
    return
  }

  // Check for duplicate IDs
  if (INPUT_COMPONENT_TYPES.has(type) && typeof c.id === 'string') {
    if (ids.has(c.id)) {
      errors.push(`Duplicate component id: "${c.id}"`)
    }
    ids.add(c.id)
  }

  // Validate required fields per type
  switch (type) {
    case 'Markdown':
      if (typeof c.content !== 'string' && typeof c.file !== 'string') {
        errors.push('Markdown requires either "content" or "file"')
      }
      break
    case 'Diagram':
      if (typeof c.content !== 'string') errors.push('Diagram.content is required')
      break
    case 'Image':
      if (typeof c.url !== 'string') errors.push('Image.url is required')
      break
    case 'Alert':
      if (typeof c.content !== 'string') errors.push('Alert.content is required')
      break
    case 'Options':
      if (typeof c.id !== 'string') errors.push('Options.id is required')
      if (!Array.isArray(c.options) || (c.options as unknown[]).length === 0) {
        errors.push('Options.options must be a non-empty array')
      }
      break
    case 'TextInput':
      if (typeof c.id !== 'string') errors.push('TextInput.id is required')
      break
    case 'ImagePicker':
      if (typeof c.id !== 'string') errors.push('ImagePicker.id is required')
      if (!Array.isArray(c.images) || (c.images as unknown[]).length === 0) {
        errors.push('ImagePicker.images must be a non-empty array')
      }
      break
    case 'Toggle':
      if (typeof c.id !== 'string') errors.push('Toggle.id is required')
      if (typeof c.label !== 'string') errors.push('Toggle.label is required')
      break
    case 'Slider':
      if (typeof c.id !== 'string') errors.push('Slider.id is required')
      break
    case 'Button':
      if (typeof c.id !== 'string') errors.push('Button.id is required')
      if (typeof c.label !== 'string') errors.push('Button.label is required')
      break
  }

  // Validate children for layout components
  if (type === 'Stack' || type === 'Grid' || type === 'Group') {
    if (depth >= MAX_NESTING) {
      errors.push(`Maximum nesting depth (${MAX_NESTING}) exceeded`)
      return
    }
    if (type === 'Group' && typeof c.label !== 'string') {
      errors.push('Group.label is required')
    }
    if (!Array.isArray(c.children)) {
      errors.push(`${type}.children is required and must be an array`)
    } else {
      for (const child of c.children as unknown[]) {
        validateComponent(child, errors, ids, depth + 1)
      }
    }
  }
}

// ─── MCP Tool Input Schema (JSON Schema for Claude) ────────────────

/**
 * Generate the JSON Schema representation for the MCP tool input.
 * This is what Claude sees in the tool definition.
 */
export function dialogToolInputSchema(): Record<string, unknown> {
  return {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Dialog title (required)' },
      description: { type: 'string', description: 'Optional subtitle/context (markdown)' },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds (default 300, min 10, max 3600)',
      },
      submitLabel: { type: 'string', description: 'Submit button label (default "Submit")' },
      cancelLabel: { type: 'string', description: 'Cancel button label (default "Cancel")' },
      body: {
        type: 'array',
        description:
          'Single-page layout. Array of components. Mutually exclusive with "pages". Component types: Markdown (content OR file -- use file to reference a local path instead of inlining text, saves context tokens; color?), Diagram (content), Image (url, alt?), Alert (intent?: info|warning|error|success, content), Divider, Options (id, options[{value,label,description?}], label?, multi?, required?, default?), TextInput (id, label?, placeholder?, required?, multiline?, default?), ImagePicker (id, images[{value,url,label?}], label?, multi?, allowUpload?), Toggle (id, label, default?), Slider (id, label?, min?, max?, step?, default?), Button (id, label, variant?: default|primary|outline|ghost, intent?: neutral|destructive|success), Stack (direction?: vertical|horizontal, children[]), Grid (columns?, children[]), Group (label, collapsed?, children[]). Colors: primary|secondary|muted|accent|destructive|success|warning|info. All text/label fields support markdown.',
        items: { type: 'object' },
      },
      pages: {
        type: 'array',
        description:
          'Multi-page layout. Array of {label, body: [...components]}. Renderer handles navigation (tabs/stepper). Last page shows submit. Mutually exclusive with "body".',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Page tab/step label' },
            body: { type: 'array', description: 'Array of components (same types as body)', items: { type: 'object' } },
          },
          required: ['label', 'body'],
        },
      },
    },
    required: ['title'],
  }
}
