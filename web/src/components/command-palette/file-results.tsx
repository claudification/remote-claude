import { FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FileResultsProps } from './types'
import { formatFileSize } from './types'

export function FileResults({
  files,
  loading,
  selectedConversationId,
  activeIndex,
  setActiveIndex,
  onFileSelect,
}: FileResultsProps) {
  if (loading) {
    return <div className="px-3 py-4 text-center text-[10px] text-comment">Loading files...</div>
  }

  if (files.length === 0) {
    return <div className="px-3 py-4 text-center text-[10px] text-comment">No .md files found</div>
  }

  return (
    <>
      {files.map((file, i) => (
        <button
          key={file.path}
          type="button"
          onClick={() => selectedConversationId && onFileSelect(selectedConversationId, file.path)}
          onMouseEnter={() => setActiveIndex(i)}
          className={cn(
            'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
            i === activeIndex ? 'bg-primary/20' : 'hover:bg-primary/10',
          )}
        >
          <FileText className="w-3.5 h-3.5 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-foreground truncate">{file.path}</div>
          </div>
          <span className="text-[10px] text-comment">{formatFileSize(file.size)}</span>
        </button>
      ))}
    </>
  )
}
