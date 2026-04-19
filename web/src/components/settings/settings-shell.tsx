import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

export interface SettingsShellTab {
  id: string
  label: string
}

interface SettingsShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  tabs: SettingsShellTab[]
  activeTab: string
  onTabChange: (tab: string) => void
  showTabs?: boolean
  headerContent?: ReactNode
  footer?: ReactNode
  children: ReactNode
  maxWidth?: 'sm' | 'md' | 'lg'
}

const MAX_WIDTH_CLASS = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
} as const

export function SettingsShell({
  open,
  onOpenChange,
  title,
  tabs,
  activeTab,
  onTabChange,
  showTabs = true,
  headerContent,
  footer,
  children,
  maxWidth = 'lg',
}: SettingsShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('p-0 gap-0 max-h-[85vh] overflow-hidden flex flex-col', MAX_WIDTH_CLASS[maxWidth])}>
        <div className="px-6 pt-6 pb-0 shrink-0">
          <DialogTitle className="uppercase tracking-wider">{title}</DialogTitle>
        </div>

        {headerContent && <div className="px-6 pt-4 pb-2 shrink-0">{headerContent}</div>}

        {showTabs && tabs.length > 1 && (
          <div className="px-6 pb-2 pt-3 shrink-0">
            <Tabs value={activeTab} onValueChange={onTabChange} className="gap-0">
              <TabsList
                variant="line"
                className="h-8 w-full gap-0 justify-start border-b border-border rounded-none px-0"
              >
                {tabs.map(t => (
                  <TabsTrigger
                    key={t.id}
                    value={t.id}
                    className="text-[11px] font-mono uppercase tracking-wider px-3 py-1 flex-none"
                  >
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {tabs.map(t => (
                <TabsContent key={t.id} value={t.id} className="hidden" />
              ))}
            </Tabs>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-3">{children}</div>

        {footer && <div className="px-6 py-3 border-t border-border shrink-0">{footer}</div>}
      </DialogContent>
    </Dialog>
  )
}
