import { describe, expect, it } from 'vitest'
import { type DialogComponent, type DialogLayout, dialogToolInputSchema, validateDialogLayout } from './dialog-schema'

describe('validateDialogLayout', () => {
  it('accepts a minimal valid layout with body', () => {
    const layout: DialogLayout = {
      title: 'Test',
      body: [{ type: 'Markdown', content: 'Hello' }],
    }
    expect(validateDialogLayout(layout)).toEqual([])
  })

  it('accepts a minimal valid layout with pages', () => {
    const layout: DialogLayout = {
      title: 'Test',
      pages: [{ label: 'Page 1', body: [{ type: 'Markdown', content: 'Hello' }] }],
    }
    expect(validateDialogLayout(layout)).toEqual([])
  })

  it('rejects non-object input', () => {
    expect(validateDialogLayout(null)).toEqual(['Layout must be an object'])
    expect(validateDialogLayout('string')).toEqual(['Layout must be an object'])
    expect(validateDialogLayout(42)).toEqual(['Layout must be an object'])
  })

  it('rejects missing title', () => {
    const errors = validateDialogLayout({ body: [{ type: 'Markdown', content: 'x' }] })
    expect(errors).toContain('title is required and must be a non-empty string')
  })

  it('rejects missing body and pages', () => {
    const errors = validateDialogLayout({ title: 'Test' })
    expect(errors).toContain('Either "body" or "pages" is required')
  })

  it('rejects both body and pages', () => {
    const errors = validateDialogLayout({
      title: 'Test',
      body: [{ type: 'Markdown', content: 'x' }],
      pages: [{ label: 'P1', body: [{ type: 'Markdown', content: 'x' }] }],
    })
    expect(errors).toContain('Provide either "body" or "pages", not both')
  })

  it('rejects empty body array', () => {
    const errors = validateDialogLayout({ title: 'Test', body: [] })
    expect(errors).toContain('body must have at least one component')
  })

  it('rejects invalid timeout', () => {
    const errors = validateDialogLayout({
      title: 'Test',
      timeout: 5, // below min 10
      body: [{ type: 'Markdown', content: 'x' }],
    })
    expect(errors).toContain('timeout must be a number between 10 and 3600')
  })

  it('accepts valid timeout', () => {
    const layout = {
      title: 'Test',
      timeout: 60,
      body: [{ type: 'Markdown', content: 'x' }],
    }
    expect(validateDialogLayout(layout)).toEqual([])
  })

  it('rejects unknown component types', () => {
    const errors = validateDialogLayout({
      title: 'Test',
      body: [{ type: 'FancyWidget', content: 'x' }],
    })
    expect(errors).toContain('Unknown component type: "FancyWidget"')
  })

  it('validates required fields per component type', () => {
    // Markdown without content
    let errors = validateDialogLayout({
      title: 'Test',
      body: [{ type: 'Markdown' }],
    })
    expect(errors).toContain('Markdown requires either "content" or "file"')

    // Options without id
    errors = validateDialogLayout({
      title: 'Test',
      body: [{ type: 'Options', options: [{ value: 'a', label: 'A' }] }],
    })
    expect(errors).toContain('Options.id is required')

    // Options without options array
    errors = validateDialogLayout({
      title: 'Test',
      body: [{ type: 'Options', id: 'test' }],
    })
    expect(errors).toContain('Options.options must be a non-empty array')

    // Toggle without label
    errors = validateDialogLayout({
      title: 'Test',
      body: [{ type: 'Toggle', id: 'test' }],
    })
    expect(errors).toContain('Toggle.label is required')

    // Button without label
    errors = validateDialogLayout({
      title: 'Test',
      body: [{ type: 'Button', id: 'test' }],
    })
    expect(errors).toContain('Button.label is required')

    // Image without url
    errors = validateDialogLayout({
      title: 'Test',
      body: [{ type: 'Image' }],
    })
    expect(errors).toContain('Image.url is required')
  })

  it('detects duplicate component IDs', () => {
    const errors = validateDialogLayout({
      title: 'Test',
      body: [
        { type: 'TextInput', id: 'name' },
        { type: 'TextInput', id: 'name' },
      ],
    })
    expect(errors).toContain('Duplicate component id: "name"')
  })

  it('validates nested children in layout components', () => {
    const layout = {
      title: 'Test',
      body: [
        {
          type: 'Stack',
          direction: 'vertical',
          children: [
            { type: 'Markdown', content: 'Hello' },
            { type: 'Options', id: 'choice', options: [{ value: 'a', label: 'A' }] },
          ],
        },
      ],
    }
    expect(validateDialogLayout(layout)).toEqual([])
  })

  it('rejects Stack without children', () => {
    const errors = validateDialogLayout({
      title: 'Test',
      body: [{ type: 'Stack', direction: 'vertical' }],
    })
    expect(errors).toContain('Stack.children is required and must be an array')
  })

  it('rejects Group without label', () => {
    const errors = validateDialogLayout({
      title: 'Test',
      body: [{ type: 'Group', children: [{ type: 'Markdown', content: 'x' }] }],
    })
    expect(errors).toContain('Group.label is required')
  })

  it('enforces max nesting depth', () => {
    // Create 5-level deep nesting (max is 4)
    let inner: Record<string, unknown> = { type: 'Markdown', content: 'deep' }
    for (let i = 0; i < 5; i++) {
      inner = { type: 'Stack', direction: 'vertical', children: [inner] }
    }
    const errors = validateDialogLayout({
      title: 'Test',
      body: [inner],
    })
    expect(errors).toContain('Maximum nesting depth (4) exceeded')
  })

  it('validates a complex multi-page layout', () => {
    const layout: DialogLayout = {
      title: 'Project Setup',
      description: 'Configure your project',
      submitLabel: 'Create',
      cancelLabel: 'Cancel',
      timeout: 120,
      pages: [
        {
          label: 'Basics',
          body: [
            { type: 'Markdown', content: '## Step 1' },
            { type: 'TextInput', id: 'name', label: 'Project name', required: true },
            {
              type: 'Options',
              id: 'lang',
              options: [
                { value: 'ts', label: 'TypeScript' },
                { value: 'py', label: 'Python' },
              ],
            },
          ],
        },
        {
          label: 'Config',
          body: [
            { type: 'Toggle', id: 'strict', label: 'Strict mode', default: true },
            { type: 'Slider', id: 'threads', label: 'Thread count', min: 1, max: 16, step: 1, default: 4 },
          ],
        },
      ],
    }
    expect(validateDialogLayout(layout)).toEqual([])
  })

  it('detects duplicate IDs across pages', () => {
    const errors = validateDialogLayout({
      title: 'Test',
      pages: [
        { label: 'P1', body: [{ type: 'TextInput', id: 'name' }] },
        { label: 'P2', body: [{ type: 'TextInput', id: 'name' }] },
      ],
    })
    expect(errors).toContain('Duplicate component id: "name"')
  })

  it('validates page structure', () => {
    const errors = validateDialogLayout({
      title: 'Test',
      pages: [
        { body: [{ type: 'Markdown', content: 'x' }] }, // missing label
      ],
    })
    expect(errors).toContain('pages[0].label is required')
  })
})

describe('dialogToolInputSchema', () => {
  it('returns a valid JSON Schema object', () => {
    const schema = dialogToolInputSchema()
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['title'])
    expect(schema.properties).toBeDefined()
    const props = schema.properties as Record<string, unknown>
    expect(props.title).toBeDefined()
    expect(props.body).toBeDefined()
    expect(props.pages).toBeDefined()
    expect(props.timeout).toBeDefined()
    expect(props.submitLabel).toBeDefined()
    expect(props.cancelLabel).toBeDefined()
  })
})

describe('DialogComponent type coverage', () => {
  it('all 14 component types are recognized as valid', () => {
    const components: DialogComponent[] = [
      { type: 'Markdown', content: 'test' },
      { type: 'Diagram', content: 'graph TD; A-->B' },
      { type: 'Image', url: 'https://example.com/img.png' },
      { type: 'Alert', content: 'Warning!', intent: 'warning' },
      { type: 'Divider' },
      { type: 'Options', id: 'opt', options: [{ value: 'a', label: 'A' }] },
      { type: 'TextInput', id: 'txt' },
      { type: 'ImagePicker', id: 'img', images: [{ value: 'a', url: 'https://x.com/a.png' }] },
      { type: 'Toggle', id: 'tog', label: 'Enable' },
      { type: 'Slider', id: 'sld' },
      { type: 'Button', id: 'btn', label: 'Go' },
      { type: 'Stack', children: [{ type: 'Markdown', content: 'nested' }] },
      { type: 'Grid', columns: 2, children: [{ type: 'Markdown', content: 'cell' }] },
      { type: 'Group', label: 'Section', children: [{ type: 'Markdown', content: 'inside' }] },
    ]

    const layout: DialogLayout = {
      title: 'All Components',
      body: components,
    }
    expect(validateDialogLayout(layout)).toEqual([])
  })
})
