/**
 * Voice streaming - Deepgram live WebSocket relay
 *
 * Flow: Browser -> broker WS -> Deepgram live WS -> interim/final results -> browser
 * After final transcript, optional Haiku refinement pass cleans up the text.
 */

import type { ServerWebSocket } from 'bun'
import { getGlobalSettings } from './global-settings'
import { getProjectSettings } from './project-settings'
import type { ConversationStore } from './session-store'

const DEEPGRAM_LIVE_URL = 'wss://api.deepgram.com/v1/listen'
const VOICE_TIMEOUT_MS = 120_000 // Max 120s recording session
const KEEPALIVE_INTERVAL_MS = 5_000 // Deepgram kills connection after 10s of no audio

interface VoiceSession {
  dgWs: WebSocket
  dashboardWs: ServerWebSocket<unknown>
  sessionId: string | null
  finalTranscript: string
  keyterms: string[]
  audioBuffer: Buffer[] // Buffer chunks while DG WS is connecting
  timeoutTimer: ReturnType<typeof setTimeout>
  keepaliveTimer: ReturnType<typeof setInterval>
  closed: boolean
}

// Active voice sessions keyed by dashboard WS identity
const voiceSessions = new Map<ServerWebSocket<unknown>, VoiceSession>()

export function handleVoiceStart(
  ws: ServerWebSocket<unknown>,
  data: { sessionId?: string; project?: string },
  sessionStore: ConversationStore,
) {
  const deepgramKey = process.env.DEEPGRAM_API_KEY
  if (!deepgramKey) {
    ws.send(JSON.stringify({ type: 'voice_error', error: 'DEEPGRAM_API_KEY not configured' }))
    return
  }

  // Clean up any existing voice session for this WS
  cleanupVoiceSession(ws)

  // Build keyterms from project settings
  const keyterms: string[] = []
  const project = data.project || (data.sessionId ? sessionStore.getSession(data.sessionId)?.project : null)
  if (project) {
    const projSettings = getProjectSettings(project)
    if (projSettings?.keyterms?.length) {
      keyterms.push(...projSettings.keyterms)
    }
  }

  // Build Deepgram live WS URL with params
  // webm/opus is a containerized format - Deepgram auto-detects, no encoding/sample_rate needed
  const params = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    punctuate: 'true',
    filler_words: 'false',
    interim_results: 'true',
    endpointing: '500', // 500ms silence = speech_final (natural conversation pace)
    vad_events: 'true',
    language: 'en',
  })
  for (const kt of keyterms) {
    params.append('keyterm', `${kt}:3`)
  }

  const dgUrl = `${DEEPGRAM_LIVE_URL}?${params}`
  console.log(`[voice-stream] Opening Deepgram live WS (${keyterms.length} keyterms)`)

  const dgWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${deepgramKey}` },
  } as unknown as string)

  const voiceSession: VoiceSession = {
    dgWs,
    dashboardWs: ws,
    sessionId: data.sessionId || null,
    finalTranscript: '',
    keyterms,
    audioBuffer: [],
    closed: false,
    timeoutTimer: setTimeout(() => {
      console.log(`[voice-stream] Session timed out (${VOICE_TIMEOUT_MS / 1000}s)`)
      stopVoiceSession(ws, 'timeout')
    }, VOICE_TIMEOUT_MS),
    // KeepAlive prevents Deepgram from killing the connection during silence
    keepaliveTimer: setInterval(() => {
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(JSON.stringify({ type: 'KeepAlive' }))
      }
    }, KEEPALIVE_INTERVAL_MS),
  }

  voiceSessions.set(ws, voiceSession)

  dgWs.onopen = () => {
    // Flush any audio buffered during connection
    const flushedChunks = voiceSession.audioBuffer.length
    const flushedBytes = voiceSession.audioBuffer.reduce((sum, b) => sum + b.length, 0)
    if (flushedChunks > 0) {
      console.log(`[voice-stream] Deepgram WS connected, flushing ${flushedChunks} buffered chunks (${flushedBytes}B)`)
      for (const chunk of voiceSession.audioBuffer) {
        dgWs.send(chunk)
      }
      voiceSession.audioBuffer = []
    } else {
      console.log('[voice-stream] Deepgram WS connected, waiting for audio...')
    }
    voiceDataCount = 0
    voiceDataBytes = 0
    ws.send(JSON.stringify({ type: 'voice_ready', flushedChunks, flushedBytes }))
  }

  dgWs.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : '')

      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0]
        if (!alt) return

        const transcript = alt.transcript || ''
        const isFinal = msg.is_final === true
        const speechFinal = msg.speech_final === true

        if (transcript) {
          if (isFinal) {
            // Accumulate final segments
            voiceSession.finalTranscript += (voiceSession.finalTranscript ? ' ' : '') + transcript
          }

          ws.send(
            JSON.stringify({
              type: 'voice_transcript',
              transcript,
              isFinal,
              speechFinal,
              accumulated: voiceSession.finalTranscript,
            }),
          )
        }
      } else if (msg.type === 'UtteranceEnd') {
        ws.send(JSON.stringify({ type: 'voice_utterance_end' }))
      } else if (msg.type === 'Metadata') {
        // Sent after CloseStream - connection is about to close
        console.log(`[voice-stream] Deepgram metadata: duration=${msg.duration}s`)
      }
    } catch (err) {
      console.error('[voice-stream] Failed to parse Deepgram message:', err)
    }
  }

  dgWs.onerror = (event: Event) => {
    console.error('[voice-stream] Deepgram WS error:', event)
    ws.send(JSON.stringify({ type: 'voice_error', error: 'Deepgram connection failed. Check server logs.' }))
    cleanupVoiceSession(ws)
  }

  dgWs.onclose = (event: CloseEvent) => {
    const reason = event.reason || 'no reason'
    console.log(
      `[voice-stream] Deepgram WS closed (code: ${event.code}, reason: "${reason}", audioChunks: ${voiceDataCount}, totalBytes: ${voiceDataBytes})`,
    )

    if (!voiceSession.closed) {
      if (voiceSession.finalTranscript) {
        voiceSession.closed = true
        refineAndSend(ws, voiceSession.finalTranscript, voiceSession.keyterms)
      } else if (voiceDataCount === 0) {
        // Deepgram closed and we never sent any audio -- something is wrong
        console.error('[voice-stream] Deepgram closed with ZERO audio chunks received from browser')
        ws.send(JSON.stringify({ type: 'voice_error', error: 'No audio data received. Check microphone permissions.' }))
        voiceSession.closed = true
      } else if (voiceDataBytes > 0 && !voiceSession.finalTranscript) {
        // Got audio but no transcript -- Deepgram couldn't decode or no speech detected
        console.warn(`[voice-stream] Deepgram closed with ${voiceDataBytes}B audio but no transcript`)
        ws.send(
          JSON.stringify({
            type: 'voice_error',
            error: 'No speech detected. Try speaking louder or closer to the mic.',
          }),
        )
        voiceSession.closed = true
      }
    }
    voiceSessions.delete(ws)
  }
}

let voiceDataCount = 0
let voiceDataBytes = 0

export function handleVoiceData(ws: ServerWebSocket<unknown>, audioBase64: string) {
  const session = voiceSessions.get(ws)
  if (!session) {
    console.warn('[voice-stream] voice_data received but no active session')
    return
  }

  const bytes = Buffer.from(audioBase64, 'base64')
  voiceDataCount++
  voiceDataBytes += bytes.length

  // Log first chunk and then every 20th chunk
  if (voiceDataCount === 1 || voiceDataCount % 20 === 0) {
    console.log(
      `[voice-stream] Audio chunk #${voiceDataCount}: ${bytes.length}B (total: ${voiceDataBytes}B, DG state: ${session.dgWs.readyState})`,
    )
  }

  if (session.dgWs.readyState === WebSocket.OPEN) {
    session.dgWs.send(bytes)
  } else if (session.dgWs.readyState === WebSocket.CONNECTING) {
    // Buffer audio while Deepgram WS is still connecting -- flush on open
    session.audioBuffer.push(bytes)
    if (session.audioBuffer.length === 1) {
      console.log('[voice-stream] Buffering audio while DG WS connects...')
    }
  } else {
    console.warn(`[voice-stream] DG WS not open (state: ${session.dgWs.readyState}), dropping ${bytes.length}B audio`)
  }
}

export function handleVoiceStop(ws: ServerWebSocket<unknown>) {
  stopVoiceSession(ws, 'user')
}

function stopVoiceSession(ws: ServerWebSocket<unknown>, reason: string) {
  const session = voiceSessions.get(ws)
  if (!session) return

  console.log(`[voice-stream] Stopping session (reason: ${reason})`)
  session.closed = true
  clearTimeout(session.timeoutTimer)
  clearInterval(session.keepaliveTimer)

  if (session.dgWs.readyState === WebSocket.OPEN) {
    // DG connected - flush pending results then close
    session.dgWs.send(JSON.stringify({ type: 'Finalize' }))
    setTimeout(() => {
      if (session.dgWs.readyState === WebSocket.OPEN) {
        session.dgWs.send(JSON.stringify({ type: 'CloseStream' }))
      }
    }, 500)

    // Short delay to catch last final results from Finalize
    setTimeout(() => {
      if (session.finalTranscript) {
        refineAndSend(ws, session.finalTranscript, session.keyterms)
      } else {
        ws.send(JSON.stringify({ type: 'voice_done', raw: '', refined: '' }))
        cleanupVoiceSession(ws)
      }
    }, 800)
  } else if (session.dgWs.readyState === WebSocket.CONNECTING) {
    // DG still connecting - wait up to 3s for it, then flush or give up
    console.log(`[voice-stream] DG still connecting at stop time, waiting up to 3s...`)
    const bufferedChunks = session.audioBuffer.length
    let resolved = false

    const giveUp = setTimeout(() => {
      if (resolved) return
      resolved = true
      console.warn(`[voice-stream] DG WS never connected (had ${bufferedChunks} buffered chunks)`)
      ws.send(
        JSON.stringify({
          type: 'voice_error',
          error: 'Voice service connection timed out. Try again.',
        }),
      )
      cleanupVoiceSession(ws)
    }, 3000)

    // If DG connects within the window, flush audio and do normal stop
    const origOnOpen = session.dgWs.onopen
    session.dgWs.onopen = (ev: Event) => {
      if (resolved) return
      resolved = true
      clearTimeout(giveUp)
      // Let original onopen flush the buffer
      if (origOnOpen) (origOnOpen as (ev: Event) => void)(ev)
      // Then do normal finalize flow
      session.dgWs.send(JSON.stringify({ type: 'Finalize' }))
      setTimeout(() => {
        if (session.dgWs.readyState === WebSocket.OPEN) {
          session.dgWs.send(JSON.stringify({ type: 'CloseStream' }))
        }
      }, 500)
      setTimeout(() => {
        if (session.finalTranscript) {
          refineAndSend(ws, session.finalTranscript, session.keyterms)
        } else {
          ws.send(JSON.stringify({ type: 'voice_done', raw: '', refined: '' }))
          cleanupVoiceSession(ws)
        }
      }, 1500) // longer delay since DG just connected and needs to process buffered audio
    }

    // If DG errors out during the wait
    session.dgWs.onerror = () => {
      if (resolved) return
      resolved = true
      clearTimeout(giveUp)
      ws.send(
        JSON.stringify({
          type: 'voice_error',
          error: 'Voice service connection failed. Try again.',
        }),
      )
      cleanupVoiceSession(ws)
    }
  } else {
    // DG already closed/closing
    if (session.finalTranscript) {
      refineAndSend(ws, session.finalTranscript, session.keyterms)
    } else {
      ws.send(JSON.stringify({ type: 'voice_done', raw: '', refined: '' }))
      cleanupVoiceSession(ws)
    }
  }
}

/**
 * Two-Step ASR Post-Processing Refinement (APR)
 *
 * Inspired by Task-Activating Prompting (TAP) from:
 * "Generative Speech Recognition Error Correction with LLMs" (Yang et al., 2023)
 *
 * Step 1 - Context Extraction: Analyze the raw transcript to discover domain context,
 *   proper nouns, locations, and likely misrecognitions. Fast structured extraction.
 * Step 2 - Refinement: Clean the transcript using TAP multi-turn structure, enriched
 *   with both project keyterms AND dynamically extracted context from step 1.
 */
async function refineAndSend(ws: ServerWebSocket<unknown>, rawText: string, keyterms: string[]) {
  const globalSettings = getGlobalSettings()
  const openrouterKey = process.env.OPENROUTER_API_KEY

  // Skip refinement if disabled in settings, no API key, or empty text
  if (!globalSettings.voiceRefinement || !openrouterKey || !rawText.trim()) {
    ws.send(JSON.stringify({ type: 'voice_done', raw: rawText, refined: rawText }))
    cleanupVoiceSession(ws)
    return
  }

  console.log(`[voice-stream] Refining (${keyterms.length} keyterms):\n  RAW: "${rawText}"`)
  ws.send(JSON.stringify({ type: 'voice_refining' }))

  try {
    // ── Step 1: Context Extraction ──────────────────────────────────
    const keytermHint = keyterms.length > 0 ? `\nKnown project terms: ${keyterms.join(', ')}` : ''

    const contextRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        messages: [
          {
            role: 'system' as const,
            content: `You analyze voice transcripts to extract context that helps correct ASR errors.${keytermHint}`,
          },
          {
            role: 'user' as const,
            content: `Analyze this voice transcript and output a brief JSON object with these fields:
- "proper_nouns": names, brands, places, tools mentioned or likely intended (array of strings)
- "domain": the topic/domain (e.g. "software development", "Thai culture", "DevOps") (string)
- "corrections": any words that are likely ASR misrecognitions, with what they probably should be (array of {"heard": "x", "meant": "y"})
- "tone": the speaker's tone/register (e.g. "casual", "technical", "formal") (string)

Output ONLY valid JSON, nothing else.

${rawText}`,
          },
        ],
        max_tokens: 512,
        temperature: 0.1,
      }),
    })

    let contextBlock = ''
    if (contextRes.ok) {
      const contextData = (await contextRes.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const contextJson = contextData.choices?.[0]?.message?.content?.trim() || ''
      console.log(`[voice-stream] Step 1 context: ${contextJson.slice(0, 300)}`)

      try {
        // Strip markdown code fences if Haiku wraps the JSON (common LLM behavior)
        const cleanJson = contextJson.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
        const ctx = JSON.parse(cleanJson)
        const parts: string[] = []
        if (ctx.domain) parts.push(`Domain: ${ctx.domain}`)
        if (ctx.tone) parts.push(`Tone: ${ctx.tone}`)
        if (ctx.proper_nouns?.length) parts.push(`Proper nouns/names: ${ctx.proper_nouns.join(', ')}`)
        if (ctx.corrections?.length) {
          const fixes = ctx.corrections
            .map((c: { heard: string; meant: string }) => `"${c.heard}" -> "${c.meant}"`)
            .join(', ')
          parts.push(`Likely ASR misrecognitions: ${fixes}`)
        }
        if (parts.length > 0) {
          contextBlock = `\n\nExtracted context from this transcript:\n${parts.join('\n')}`
        }
      } catch {
        console.warn('[voice-stream] Step 1 returned non-JSON, proceeding with step 2 anyway')
      }
    } else {
      const errBody = await contextRes.text().catch(() => '')
      console.warn(`[voice-stream] Step 1 context extraction failed: ${contextRes.status} ${errBody.slice(0, 200)}`)
    }

    // ── Step 2: Refinement with enriched context ────────────────────
    const keytermBlock =
      keyterms.length > 0
        ? `\nDomain vocabulary (correct spellings for this project): ${keyterms.join(', ')}\nWhen the transcript contains words that sound similar to these terms, prefer the domain term.`
        : ''

    const defaultSystemPrompt = `You are an expert ASR (Automatic Speech Recognition) post-processor. You specialize in cleaning up voice-transcribed text that will be used as prompts for a coding AI assistant.

You understand common ASR failure modes:
- Homophones and near-homophones (e.g. "their/there/they're", "write/right", "new/knew")
- Word boundary errors where ASR splits or merges words incorrectly (e.g. "react server" vs "React Server", "type script" vs "TypeScript")
- Technical term misrecognition (API names, libraries, CLI tools often get mangled)
- Disfluencies: false starts, self-corrections, filler words, repetitions
- Spoken punctuation and syntax references`

    const systemPrompt = globalSettings.voiceRefinementPrompt || defaultSystemPrompt

    const messages = [
      {
        role: 'system' as const,
        content: `${systemPrompt}${keytermBlock}${contextBlock}`,
      },
      {
        role: 'user' as const,
        content: `Here's an example of a raw voice transcript and its corrected version:

Raw: "okay so um I want to add a new end point uh to the API that handles like user authentication no no wait not authentication I mean authorization slash permissions and it should use jason web tokens uh jwt for the for the token format"

Corrected: "I want to add a new endpoint to the API that handles authorization/permissions and it should use JSON Web Tokens (JWT) for the token format"

Notice how: filler words removed, self-correction applied ("not authentication, I mean authorization"), "end point" merged to "endpoint", "jason" corrected to "JSON", "slash" converted to "/", repeated words cleaned up, but the speaker's casual tone and intent are preserved exactly.`,
      },
      {
        role: 'assistant' as const,
        content:
          "Understood. I will clean the transcript by removing disfluencies, applying self-corrections, fixing ASR errors (especially technical terms and word boundaries), and converting spoken syntax to written form - while preserving the speaker's original intent and tone.",
      },
      {
        role: 'user' as const,
        content: `Clean this voice transcript. Apply all corrections. Output ONLY the cleaned text - no quotes, no explanation, no preamble, no "Here's the corrected version" prefix.

${rawText}`,
      },
    ]

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        messages,
        max_tokens: 2048,
        temperature: 0.3,
      }),
    })

    if (res.ok) {
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      let refined = data.choices?.[0]?.message?.content?.trim() || rawText
      refined = stripPreamble(refined)
      console.log(`[voice-stream] Refined:\n  OUT: "${refined}"`)
      ws.send(JSON.stringify({ type: 'voice_done', raw: rawText, refined }))
    } else {
      const errBody = await res.text().catch(() => '')
      console.error(`[voice-stream] Step 2 refinement failed: ${res.status} ${errBody.slice(0, 500)}`)
      ws.send(JSON.stringify({ type: 'voice_done', raw: rawText, refined: rawText }))
    }
  } catch (err) {
    console.error('[voice-stream] Refinement error:', err)
    ws.send(JSON.stringify({ type: 'voice_done', raw: rawText, refined: rawText }))
  }

  cleanupVoiceSession(ws)
}

/** Strip common LLM preamble patterns that leak through despite instructions */
function stripPreamble(text: string): string {
  // Remove leading patterns like "Here's the corrected version:" or "Corrected:" etc.
  const preamblePatterns = [
    /^(?:here(?:'s| is) (?:the )?(?:cleaned|corrected|refined|fixed)(?: version)?[:\s-]+)/i,
    /^(?:corrected|cleaned|refined|fixed)(?: (?:version|text|transcript))?[:\s-]+/i,
    /^(?:sure[,!.]?\s*)/i,
  ]
  let result = text
  for (const pattern of preamblePatterns) {
    result = result.replace(pattern, '')
  }
  return result.trim()
}

function cleanupVoiceSession(ws: ServerWebSocket<unknown>) {
  const session = voiceSessions.get(ws)
  if (!session) return

  clearTimeout(session.timeoutTimer)
  clearInterval(session.keepaliveTimer)
  if (session.dgWs.readyState === WebSocket.OPEN || session.dgWs.readyState === WebSocket.CONNECTING) {
    try {
      session.dgWs.close()
    } catch {}
  }
  voiceSessions.delete(ws)
}

/** Clean up voice session when dashboard WS disconnects */
export function cleanupVoiceForWs(ws: ServerWebSocket<unknown>) {
  cleanupVoiceSession(ws)
}
