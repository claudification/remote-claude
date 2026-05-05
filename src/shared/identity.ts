/**
 * Identity types for the claudwerk system.
 *
 * Plain type aliases today -- structurally equivalent to string but document
 * intent at every call site. Can be upgraded to branded types later if
 * cross-assignment bugs persist.
 *
 * Boundary model:
 *   Agent host: owns CC sessions (ccSessionId). Translates to ConversationId
 *               at the wire boundary when talking to the broker.
 *   Broker:     owns conversations (ConversationId) and tracks connections
 *               (ConnectionId) per conversation. Does NOT know about CC.
 *   Dashboard:  reads ConversationId and ConnectionId from the broker.
 */

/** Broker's primary key. One conversation = one logical unit of work. */
export type ConversationId = string

/** Agent host socket identity within a conversation. Multiple connections can serve one conversation. */
export type ConnectionId = string

/** Spawn job tracker. Temporary -- expires after completion. */
export type JobId = string

/** Project URI (e.g. claude:///home/user/project). Identifies a project across conversations.
 * Canonical structured type lives in project-uri.ts (ProjectUri interface).
 * This is the plain string alias -- use when a raw URI string is sufficient. */
export type ProjectUri = string
