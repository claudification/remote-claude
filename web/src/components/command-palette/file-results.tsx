import { FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FileResultsProps } from './types'
import { formatFileSize } from './types'

export function FileResults({
  files,
  loading,
  selectedSessionId,
  activeIndex,
  setActiveIndex,
  onFileSelect,
}: FileResultsProps) {
  if (loading) {
    return <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">Loading files...</div>
  }

  if (files.length === 0) {
    return <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">No .md files found</div>
  }

  return (
    <>
      {files.map((file, i) => (
        <button
          key={file.path}
          type="button"
          onClick={() => selectedSessionId && onFileSelect(selectedSessionId, file.path)}
          onMouseEnter={() => setActiveIndex(i)}
          className={cn(
            'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
            i === activeIndex ? 'bg-[#33467c]/50' : 'hover:bg-[#33467c]/25',
          )}
        >
          <FileText className="w-3.5 h-3.5 text-[#7aa2f7] shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-[#a9b1d6] truncate">{file.path}</div>
          </div>
          <span className="text-[10px] text-[#565f89]">{formatFileSize(file.size)}</span>
        </button>
      ))}
    </>
  )
}
