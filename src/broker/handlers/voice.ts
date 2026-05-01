/**
 * Voice streaming handlers: browser <-> Deepgram via broker relay.
 * Delegates to voice-stream.ts which manages the Deepgram WebSocket connection.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'
import { handleVoiceData, handleVoiceStart, handleVoiceStop } from '../voice-stream'

const voiceStart: MessageHandler = (ctx, data) => {
  ctx.requirePermission('voice')
  handleVoiceStart(ctx.ws, data, ctx.conversations)
}

const voiceData: MessageHandler = (ctx, data) => {
  handleVoiceData(ctx.ws, data.audio as string)
}

const voiceStop: MessageHandler = ctx => {
  handleVoiceStop(ctx.ws)
}

export function registerVoiceHandlers(): void {
  registerHandlers({
    voice_start: voiceStart,
    voice_data: voiceData,
    voice_stop: voiceStop,
  })
}
