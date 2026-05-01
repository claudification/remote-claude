import type { ServerWebSocket } from 'bun'

export interface SyncState {
  readonly epoch: string
  seq: number
  bufferHead: number
  bufferCount: number
  readonly buffer: Array<{ seq: number; json: string }>
}

const SYNC_BUFFER_SIZE = 500

export function createSyncState(): SyncState {
  return {
    epoch: Math.random().toString(36).slice(2, 10),
    seq: 0,
    bufferHead: 0,
    bufferCount: 0,
    buffer: new Array(SYNC_BUFFER_SIZE),
  }
}

export function stampAndBuffer(sync: SyncState, message: unknown): string {
  const seq = ++sync.seq
  const json = JSON.stringify({ _epoch: sync.epoch, _seq: seq, ...(message as Record<string, unknown>) })
  sync.buffer[sync.bufferHead] = { seq, json }
  sync.bufferHead = (sync.bufferHead + 1) % SYNC_BUFFER_SIZE
  if (sync.bufferCount < SYNC_BUFFER_SIZE) sync.bufferCount++
  return json
}

export function syncStamp(sync: SyncState, message: unknown): string {
  return JSON.stringify({ _epoch: sync.epoch, _seq: sync.seq, ...(message as Record<string, unknown>) })
}

export function sendSyncResponse(
  sync: SyncState,
  ws: ServerWebSocket<unknown>,
  type: string,
  extra?: Record<string, unknown>,
): void {
  ws.send(JSON.stringify({ type, epoch: sync.epoch, seq: sync.seq, ...extra }))
}

export function handleSyncCheck(
  sync: SyncState,
  ws: ServerWebSocket<unknown>,
  clientEpoch: string,
  clientSeq: number,
  clientTranscripts: Record<string, number> | undefined,
  transcriptSeqCounters: Map<string, number>,
): void {
  const wsData = ws.data as { userName?: string } | undefined
  const who = wsData?.userName ? `dash:${wsData.userName}` : 'dash'

  const staleTranscripts: Record<string, number> = {}
  const staleDetails: string[] = []
  if (clientTranscripts) {
    for (const [sid, clientLastSeq] of Object.entries(clientTranscripts)) {
      const serverLastSeq = transcriptSeqCounters.get(sid) ?? 0
      if (serverLastSeq > clientLastSeq) {
        staleTranscripts[sid] = serverLastSeq
        staleDetails.push(`${sid.slice(0, 8)} serverSeq=${serverLastSeq} clientSeq=${clientLastSeq}`)
      }
    }
  }
  const staleCount = Object.keys(staleTranscripts).length
  const transcriptExtra = staleCount > 0 ? { staleTranscripts } : undefined

  function logResponse(responseType: string, extra?: string): void {
    const stalePart = staleCount > 0 ? ` stale=[${staleDetails.join(' ')}]` : ''
    const extraPart = extra ? ` ${extra}` : ''
    console.log(
      `[${who}] sync_check clientEpoch=${clientEpoch.slice(0, 8)} clientSeq=${clientSeq} transcripts=${clientTranscripts ? Object.keys(clientTranscripts).length : 0} -> ${responseType}${extraPart}${stalePart}`,
    )
  }

  if (clientEpoch !== sync.epoch) {
    sendSyncResponse(sync, ws, 'sync_stale', { reason: 'epoch_changed', ...transcriptExtra })
    logResponse('sync_stale', `reason=epoch_changed serverEpoch=${sync.epoch.slice(0, 8)}`)
    return
  }
  if (clientSeq >= sync.seq) {
    sendSyncResponse(sync, ws, 'sync_ok', transcriptExtra)
    logResponse('sync_ok')
    return
  }
  if (sync.bufferCount === 0) {
    sendSyncResponse(sync, ws, 'sync_ok', transcriptExtra)
    logResponse('sync_ok', 'empty-buffer')
    return
  }
  const oldestIdx = (sync.bufferHead - sync.bufferCount + SYNC_BUFFER_SIZE) % SYNC_BUFFER_SIZE
  const oldestSeq = sync.buffer[oldestIdx].seq
  if (clientSeq < oldestSeq) {
    sendSyncResponse(sync, ws, 'sync_stale', {
      reason: 'gap_too_large',
      missed: sync.seq - clientSeq,
      ...transcriptExtra,
    })
    logResponse('sync_stale', `reason=gap_too_large missed=${sync.seq - clientSeq}`)
    return
  }
  const startOffset = clientSeq - oldestSeq + 1
  const count = sync.bufferCount - startOffset
  sendSyncResponse(sync, ws, 'sync_catchup', { count, ...transcriptExtra })
  logResponse('sync_catchup', `replaying=${count}`)
  for (let i = 0; i < count; i++) {
    const idx = (oldestIdx + startOffset + i) % SYNC_BUFFER_SIZE
    try {
      ws.send(sync.buffer[idx].json)
    } catch {
      break
    }
  }
}
