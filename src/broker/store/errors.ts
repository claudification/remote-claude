class StoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreError'
  }
}

export class ConversationNotFound extends StoreError {
  constructor(id: string) {
    super(`Conversation not found: ${id}`)
    this.name = 'SessionNotFound'
  }
}

export class DuplicateEntry extends StoreError {
  constructor(message: string) {
    super(message)
    this.name = 'DuplicateEntry'
  }
}
