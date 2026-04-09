/**
 * Dialog Component Renderer
 *
 * Maps JSON component types to React components.
 * All text supports markdown. Colors use semantic tokens.
 */

import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info } from 'lucide-react'
import { memo, useState } from 'react'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn, haptic } from '@/lib/utils'
import type { AlertIntent, ButtonIntent, ButtonVariant, DialogColor, DialogComponent } from './types'

// ─── Color mapping ─────────────────────────────────────────────────

const COLOR_CLASSES: Record<string, string> = {
  primary: 'text-primary',
  secondary: 'text-secondary-foreground',
  muted: 'text-muted-foreground',
  accent: 'text-accent-foreground',
  destructive: 'text-destructive',
  success: 'text-emerald-500',
  warning: 'text-amber-500',
  info: 'text-blue-500',
}

// ─── Form state type ───────────────────────────────────────────────

export interface DialogFormState {
  values: Record<string, unknown>
  setValue: (id: string, value: unknown) => void
  activeAction?: string | null
}

// ─── Component renderers ───────────────────────────────────────────

function MarkdownBlock({ content, color }: { content: string; color?: DialogColor }) {
  return (
    <div className={cn('prose prose-sm dark:prose-invert max-w-none', color && COLOR_CLASSES[color])}>
      <Markdown>{content}</Markdown>
    </div>
  )
}

function DiagramBlock({ content }: { content: string }) {
  return (
    <div className="w-full overflow-x-auto rounded border border-border/30 bg-muted/20 p-4">
      <Markdown>{`\`\`\`mermaid\n${content}\n\`\`\``}</Markdown>
    </div>
  )
}

function ImageBlock({ url, alt }: { url: string; alt?: string }) {
  return (
    <div className="flex justify-center">
      <img src={url} alt={alt || ''} className="max-w-full max-h-80 rounded border border-border/30 object-contain" />
    </div>
  )
}

const ALERT_STYLES: Record<string, { bg: string; border: string; icon: typeof Info }> = {
  info: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', icon: Info },
  warning: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', icon: AlertTriangle },
  error: { bg: 'bg-destructive/10', border: 'border-destructive/30', icon: AlertCircle },
  success: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', icon: CheckCircle2 },
}

function AlertBlock({ intent, content }: { intent?: AlertIntent; content: string }) {
  const style = ALERT_STYLES[intent || 'info'] || ALERT_STYLES.info
  const Icon = style.icon
  return (
    <div className={cn('flex gap-2 items-start rounded px-3 py-2 border text-sm', style.bg, style.border)}>
      <Icon className="size-4 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <Markdown inline>{content}</Markdown>
      </div>
    </div>
  )
}

function DividerBlock() {
  return <hr className="border-border/40 my-1" />
}

// ─── Input components ──────────────────────────────────────────────

function OptionsInput({
  id,
  label,
  options,
  multi,
  form,
}: {
  id: string
  label?: string
  options: Array<{ value: string; label: string; description?: string }>
  multi?: boolean
  form: DialogFormState
}) {
  const current = form.values[id]

  function handleSelect(value: string) {
    haptic('tap')
    if (multi) {
      const arr = (Array.isArray(current) ? current : []) as string[]
      const next = arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value]
      form.setValue(id, next)
    } else {
      form.setValue(id, value)
    }
  }

  return (
    <div className="space-y-1.5">
      {label && (
        <div className="text-sm font-medium text-foreground/80">
          <Markdown inline>{label}</Markdown>
        </div>
      )}
      <div className="space-y-1">
        {options.map(opt => {
          const selected = multi ? (Array.isArray(current) ? current : []).includes(opt.value) : current === opt.value

          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: dialog option
            // biome-ignore lint/a11y/noStaticElementInteractions: dialog option
            <div
              key={opt.value}
              onClick={() => handleSelect(opt.value)}
              className={cn(
                'flex items-start gap-3 px-3.5 py-3 rounded cursor-pointer border transition-colors text-sm',
                selected
                  ? 'bg-primary/10 border-primary/40 text-foreground'
                  : 'bg-muted/30 border-border/30 text-foreground/70 hover:bg-muted/50',
              )}
            >
              {multi ? (
                <Checkbox checked={selected} className="mt-0.5" />
              ) : (
                <div
                  className={cn(
                    'size-5 mt-0.5 rounded-full border-2 shrink-0 flex items-center justify-center',
                    selected ? 'border-primary' : 'border-muted-foreground/40',
                  )}
                >
                  {selected && <div className="size-2.5 rounded-full bg-primary" />}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium">
                  <Markdown inline>{opt.label}</Markdown>
                </div>
                {opt.description && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    <Markdown inline>{opt.description}</Markdown>
                  </div>
                )}
                {selected && (
                  <input
                    type="text"
                    placeholder="Add a note..."
                    value={(form.values[`${id}_note_${opt.value}`] as string) || ''}
                    onChange={e => {
                      e.stopPropagation()
                      form.setValue(`${id}_note_${opt.value}`, e.target.value)
                    }}
                    onClick={e => e.stopPropagation()}
                    className="mt-1.5 w-full text-xs bg-background/50 border border-border/40 rounded px-2 py-1 placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TextInputField({
  id,
  label,
  placeholder,
  multiline,
  form,
}: {
  id: string
  label?: string
  placeholder?: string
  multiline?: boolean
  form: DialogFormState
}) {
  const value = (form.values[id] as string) || ''
  const InputTag = multiline ? 'textarea' : 'input'

  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={`dialog-${id}`} className="text-sm font-medium text-foreground/80">
          <Markdown inline>{label}</Markdown>
        </label>
      )}
      <InputTag
        id={`dialog-${id}`}
        value={value}
        onChange={e => form.setValue(id, e.target.value)}
        placeholder={placeholder}
        className={cn(
          'w-full rounded border border-border/50 bg-background px-3 py-2 text-sm',
          'placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50',
          multiline && 'min-h-20 resize-y',
        )}
        rows={multiline ? 3 : undefined}
      />
    </div>
  )
}

function ImagePickerInput({
  id,
  label,
  images,
  multi,
  form,
}: {
  id: string
  label?: string
  images: Array<{ value: string; url: string; label?: string }>
  multi?: boolean
  form: DialogFormState
}) {
  const current = form.values[id]

  function handleSelect(value: string) {
    haptic('tap')
    if (multi) {
      const arr = (Array.isArray(current) ? current : []) as string[]
      const next = arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value]
      form.setValue(id, next)
    } else {
      form.setValue(id, value)
    }
  }

  return (
    <div className="space-y-1.5">
      {label && (
        <div className="text-sm font-medium text-foreground/80">
          <Markdown inline>{label}</Markdown>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {images.map(img => {
          const selected = multi ? (Array.isArray(current) ? current : []).includes(img.value) : current === img.value
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: dialog image picker
            // biome-ignore lint/a11y/noStaticElementInteractions: dialog image picker
            <div
              key={img.value}
              onClick={() => handleSelect(img.value)}
              className={cn(
                'relative cursor-pointer rounded border-2 overflow-hidden transition-all',
                selected ? 'border-primary ring-1 ring-primary/30' : 'border-border/30 hover:border-border/60',
              )}
            >
              <img src={img.url} alt={img.label || img.value} className="w-full h-24 object-cover" />
              {img.label && <div className="px-2 py-1 text-xs text-center truncate bg-muted/50">{img.label}</div>}
              {selected && (
                <div className="absolute top-1 right-1 size-5 rounded-full bg-primary flex items-center justify-center">
                  <CheckCircle2 className="size-3 text-primary-foreground" />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ToggleInput({ id, label, form }: { id: string; label: string; form: DialogFormState }) {
  const checked = form.values[id] === true

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: dialog toggle
    // biome-ignore lint/a11y/noStaticElementInteractions: dialog toggle
    <div
      className="flex items-center gap-3 cursor-pointer py-1"
      onClick={() => {
        haptic('tap')
        form.setValue(id, !checked)
      }}
    >
      <div
        className={cn(
          'relative w-9 h-5 rounded-full transition-colors shrink-0',
          checked ? 'bg-primary' : 'bg-muted-foreground/30',
        )}
      >
        <div
          className={cn(
            'absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </div>
      <span className="text-sm text-foreground/80">
        <Markdown inline>{label}</Markdown>
      </span>
    </div>
  )
}

function SliderInput({
  id,
  label,
  min = 0,
  max = 100,
  step = 1,
  form,
}: {
  id: string
  label?: string
  min?: number
  max?: number
  step?: number
  form: DialogFormState
}) {
  const value = typeof form.values[id] === 'number' ? (form.values[id] as number) : min

  return (
    <div className="space-y-1.5">
      {label && (
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground/80">
            <Markdown inline>{label}</Markdown>
          </span>
          <span className="text-sm font-mono text-muted-foreground">{value}</span>
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => form.setValue(id, Number(e.target.value))}
        className="w-full accent-primary"
      />
      <div className="flex justify-between text-[10px] text-muted-foreground/60">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  )
}

// ─── Action button ─────────────────────────────────────────────────

const BUTTON_VARIANT_MAP: Record<string, 'default' | 'destructive' | 'outline' | 'ghost' | 'secondary'> = {
  default: 'default',
  primary: 'default',
  outline: 'outline',
  ghost: 'ghost',
}

function ActionButton({
  id,
  label,
  variant,
  intent,
  onAction,
  isActive,
}: {
  id: string
  label: string
  variant?: ButtonVariant
  intent?: ButtonIntent
  onAction: (actionId: string) => void
  isActive?: boolean
}) {
  const btnVariant = intent === 'destructive' ? 'destructive' : BUTTON_VARIANT_MAP[variant || 'default'] || 'default'

  return (
    <Button
      variant={btnVariant}
      size="sm"
      className={cn(isActive && 'ring-2 ring-primary ring-offset-1 ring-offset-background')}
      onClick={() => {
        haptic('tap')
        onAction(id)
      }}
    >
      {label}
    </Button>
  )
}

// ─── Layout components ─────────────────────────────────────────────

function StackLayout({
  direction = 'vertical',
  children,
  form,
  onAction,
}: {
  direction?: 'vertical' | 'horizontal'
  children: DialogComponent[]
  form: DialogFormState
  onAction: (actionId: string) => void
}) {
  return (
    <div className={cn(direction === 'horizontal' ? 'flex flex-wrap gap-2 items-start' : 'flex flex-col gap-3')}>
      {children.map((child, i) => (
        <ComponentRenderer key={i} component={child} form={form} onAction={onAction} />
      ))}
    </div>
  )
}

function GridLayout({
  columns = 2,
  children,
  form,
  onAction,
}: {
  columns?: number
  children: DialogComponent[]
  form: DialogFormState
  onAction: (actionId: string) => void
}) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(columns, 4)}, minmax(0, 1fr))` }}>
      {children.map((child, i) => (
        <ComponentRenderer key={i} component={child} form={form} onAction={onAction} />
      ))}
    </div>
  )
}

function GroupLayout({
  label,
  collapsed: initialCollapsed = false,
  children,
  form,
  onAction,
}: {
  label: string
  collapsed?: boolean
  children: DialogComponent[]
  form: DialogFormState
  onAction: (actionId: string) => void
}) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed)

  return (
    <div className="rounded border border-border/30 overflow-hidden">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: dialog group header */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dialog group header */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-muted/30 cursor-pointer select-none"
        onClick={() => {
          haptic('tick')
          setIsCollapsed(!isCollapsed)
        }}
      >
        {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        <span className="text-sm font-medium">{label}</span>
      </div>
      {!isCollapsed && (
        <div className="p-3 space-y-3">
          {children.map((child, i) => (
            <ComponentRenderer key={i} component={child} form={form} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main component renderer ───────────────────────────────────────

export const ComponentRenderer = memo(function ComponentRenderer({
  component,
  form,
  onAction,
}: {
  component: DialogComponent
  form: DialogFormState
  onAction: (actionId: string) => void
}) {
  switch (component.type) {
    // Content
    case 'Markdown':
      return <MarkdownBlock content={component.content || ''} color={component.color} />
    case 'Diagram':
      return <DiagramBlock content={component.content} />
    case 'Image':
      return <ImageBlock url={component.url} alt={component.alt} />
    case 'Alert':
      return <AlertBlock intent={component.intent} content={component.content} />
    case 'Divider':
      return <DividerBlock />

    // Input
    case 'Options':
      return (
        <OptionsInput
          id={component.id}
          label={component.label}
          options={component.options}
          multi={component.multi}
          form={form}
        />
      )
    case 'TextInput':
      return (
        <TextInputField
          id={component.id}
          label={component.label}
          placeholder={component.placeholder}
          multiline={component.multiline}
          form={form}
        />
      )
    case 'ImagePicker':
      return (
        <ImagePickerInput
          id={component.id}
          label={component.label}
          images={component.images}
          multi={component.multi}
          form={form}
        />
      )
    case 'Toggle':
      return <ToggleInput id={component.id} label={component.label} form={form} />
    case 'Slider':
      return (
        <SliderInput
          id={component.id}
          label={component.label}
          min={component.min}
          max={component.max}
          step={component.step}
          form={form}
        />
      )

    // Action
    case 'Button':
      return (
        <ActionButton
          id={component.id}
          label={component.label}
          variant={component.variant}
          intent={component.intent}
          onAction={onAction}
          isActive={form.activeAction === component.id}
        />
      )

    // Layout
    case 'Stack':
      return (
        <StackLayout direction={component.direction} children={component.children} form={form} onAction={onAction} />
      )
    case 'Grid':
      return <GridLayout columns={component.columns} children={component.children} form={form} onAction={onAction} />
    case 'Group':
      return (
        <GroupLayout
          label={component.label}
          collapsed={component.collapsed}
          children={component.children}
          form={form}
          onAction={onAction}
        />
      )

    default:
      return null
  }
})
