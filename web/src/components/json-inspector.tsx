import { lazy, Suspense, useState } from 'react'
import { Info } from 'lucide-react'
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from '@/components/ui/dialog'

const JsonHighlight = lazy(() => import('./json-highlight'))

interface JsonInspectorProps {
	title: string
	data: Record<string, unknown>
	result?: string
	extra?: Record<string, unknown>
}

export function JsonInspector({ title, data, result, extra }: JsonInspectorProps) {
	const [open, setOpen] = useState(false)

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<button
					type="button"
					className="text-muted-foreground/40 hover:text-muted-foreground transition-colors p-0.5"
					title="Inspect raw data"
					onClick={e => e.stopPropagation()}
				>
					<Info className="w-3 h-3" />
				</button>
			</DialogTrigger>
			<DialogContent>
				<div className="p-4 border-b border-border">
					<DialogTitle>{title}</DialogTitle>
				</div>
				<div className="flex-1 overflow-y-auto p-4 font-mono text-xs">
					<Suspense fallback={<div className="text-muted-foreground">Loading...</div>}>
						{open && (
							<div className="space-y-4">
								<section>
									<div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-2">Input</div>
									<JsonHighlight data={data} />
								</section>
								{result && (
									<section>
										<div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-2">Result</div>
										<pre className="whitespace-pre-wrap text-foreground/80 bg-black/20 p-3 max-h-60 overflow-auto">
											{result}
										</pre>
									</section>
								)}
								{extra && Object.keys(extra).length > 0 && (
									<section>
										<div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-2">Extra</div>
										<JsonHighlight data={extra} />
									</section>
								)}
							</div>
						)}
					</Suspense>
				</div>
			</DialogContent>
		</Dialog>
	)
}
