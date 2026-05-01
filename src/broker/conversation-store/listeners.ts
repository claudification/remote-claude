export interface ListenerRegistry {
  addSpawnListener: (requestId: string, cb: (result: unknown) => void) => void
  removeSpawnListener: (requestId: string) => void
  resolveSpawn: (requestId: string, result: unknown) => void
  addDirListener: (requestId: string, cb: (result: unknown) => void) => void
  removeDirListener: (requestId: string) => void
  resolveDir: (requestId: string, result: unknown) => void
  addFileListener: (requestId: string, cb: (result: unknown) => void) => void
  removeFileListener: (requestId: string) => void
  resolveFile: (requestId: string, result: unknown) => boolean
}

export function createListenerRegistry(): ListenerRegistry {
  const spawnListeners = new Map<string, (result: unknown) => void>()
  const dirListeners = new Map<string, (result: unknown) => void>()
  const fileListeners = new Map<string, (result: unknown) => void>()

  return {
    addSpawnListener(requestId, cb) {
      spawnListeners.set(requestId, cb)
    },
    removeSpawnListener(requestId) {
      spawnListeners.delete(requestId)
    },
    resolveSpawn(requestId, result) {
      const cb = spawnListeners.get(requestId)
      if (cb) {
        spawnListeners.delete(requestId)
        cb(result)
      }
    },
    addDirListener(requestId, cb) {
      dirListeners.set(requestId, cb)
    },
    removeDirListener(requestId) {
      dirListeners.delete(requestId)
    },
    resolveDir(requestId, result) {
      const cb = dirListeners.get(requestId)
      if (cb) {
        dirListeners.delete(requestId)
        cb(result)
      }
    },
    addFileListener(requestId, cb) {
      fileListeners.set(requestId, cb)
    },
    removeFileListener(requestId) {
      fileListeners.delete(requestId)
    },
    resolveFile(requestId, result) {
      const cb = fileListeners.get(requestId)
      if (cb) {
        fileListeners.delete(requestId)
        cb(result)
        return true
      }
      return false
    },
  }
}
