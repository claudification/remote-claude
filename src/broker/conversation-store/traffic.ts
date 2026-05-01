const TRAFFIC_WINDOW_MS = 3000

export interface TrafficTracker {
  recordTraffic: (direction: 'in' | 'out', bytes: number) => void
  getTrafficStats: () => {
    in: { messagesPerSec: number; bytesPerSec: number }
    out: { messagesPerSec: number; bytesPerSec: number }
  }
}

export function createTrafficTracker(): TrafficTracker {
  const trafficSamples: Array<{ t: number; dir: 'in' | 'out'; bytes: number }> = []

  function prune(): void {
    const cutoff = Date.now() - TRAFFIC_WINDOW_MS
    while (trafficSamples.length > 0 && trafficSamples[0].t < cutoff) {
      trafficSamples.shift()
    }
  }

  return {
    recordTraffic(direction, bytes) {
      trafficSamples.push({ t: Date.now(), dir: direction, bytes })
      prune()
    },

    getTrafficStats() {
      prune()
      const windowSec = TRAFFIC_WINDOW_MS / 1000
      let inMsgs = 0
      let inBytes = 0
      let outMsgs = 0
      let outBytes = 0
      for (const s of trafficSamples) {
        if (s.dir === 'in') {
          inMsgs++
          inBytes += s.bytes
        } else {
          outMsgs++
          outBytes += s.bytes
        }
      }
      return {
        in: { messagesPerSec: +(inMsgs / windowSec).toFixed(1), bytesPerSec: Math.round(inBytes / windowSec) },
        out: { messagesPerSec: +(outMsgs / windowSec).toFixed(1), bytesPerSec: Math.round(outBytes / windowSec) },
      }
    },
  }
}
