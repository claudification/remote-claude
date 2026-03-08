/**
 * WebAuthn Passkey Authentication
 *
 * Passkeys can ONLY be created via CLI-generated invite links.
 * No self-registration. No backdoors. No bullshit.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes, createHmac } from "crypto";
import type {
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

// --- Types ---

export interface StoredCredential {
  credentialId: string; // base64url
  publicKey: string; // base64url encoded
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  registeredAt: number;
}

export interface PasskeyUser {
  name: string; // unique, required
  credentials: StoredCredential[];
  createdAt: number;
  lastUsedAt?: number;
  revoked: boolean;
}

export interface Invite {
  token: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

interface AuthState {
  users: PasskeyUser[];
  invites: Invite[];
  sessions: Record<string, { name: string; expiresAt: number }>;
}

// --- Constants ---

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const INVITE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const HMAC_SECRET_LENGTH = 32;

// --- State ---

let state: AuthState = { users: [], invites: [], sessions: {} };
let authFilePath = "";
let hmacSecret = "";
let rpId = "localhost";
let rpName = "Claude Concentrator";
let expectedOrigins: string[] = ["http://localhost:9999"];

// In-memory challenge store (short-lived, no need to persist)
const challenges = new Map<string, { challenge: string; expiresAt: number }>();

// --- Init ---

export function initAuth(opts: {
  cacheDir: string;
  rpId?: string;
  rpName?: string;
  expectedOrigins?: string[];
  skipTimers?: boolean;
}): void {
  const dir = opts.cacheDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  authFilePath = join(dir, "auth.json");
  const secretPath = join(dir, "auth.secret");

  if (opts.rpId) rpId = opts.rpId;
  if (opts.rpName) rpName = opts.rpName;
  if (opts.expectedOrigins) expectedOrigins = opts.expectedOrigins;

  // Load or create HMAC secret
  if (existsSync(secretPath)) {
    hmacSecret = readFileSync(secretPath, "utf-8").trim();
  } else {
    hmacSecret = randomBytes(HMAC_SECRET_LENGTH).toString("hex");
    writeFileSync(secretPath, hmacSecret, { mode: 0o600 });
  }

  // Load state
  if (existsSync(authFilePath)) {
    try {
      state = JSON.parse(readFileSync(authFilePath, "utf-8"));
      // Clean expired sessions on load
      const now = Date.now();
      for (const [token, session] of Object.entries(state.sessions)) {
        if (session.expiresAt < now) delete state.sessions[token];
      }
    } catch {
      state = { users: [], invites: [], sessions: {} };
    }
  }

  // Clean expired challenges periodically (only in long-running server, not CLI)
  if (!opts.skipTimers) {
    setInterval(() => {
      const now = Date.now();
      for (const [key, val] of challenges) {
        if (val.expiresAt < now) challenges.delete(key);
      }
    }, 60_000);
  }
}

function save(): void {
  writeFileSync(authFilePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// --- Auth state queries ---

export function hasAnyUsers(): boolean {
  return state.users.some(u => !u.revoked && u.credentials.length > 0);
}

export function getRpId(): string { return rpId; }
export function getRpName(): string { return rpName; }
export function getExpectedOrigins(): string[] { return expectedOrigins; }

// --- Invite management ---

export function createInvite(name: string): { token: string; expiresAt: number } {
  // Enforce unique names
  if (state.users.some(u => u.name === name)) {
    throw new Error(`Name "${name}" already taken by an existing passkey user`);
  }
  if (state.invites.some(i => i.name === name && !i.used && i.expiresAt > Date.now())) {
    throw new Error(`Active invite for "${name}" already exists`);
  }

  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const invite: Invite = {
    token,
    name,
    createdAt: now,
    expiresAt: now + INVITE_MAX_AGE_MS,
    used: false,
  };

  state.invites.push(invite);
  save();

  return { token, expiresAt: invite.expiresAt };
}

export function validateInvite(token: string): Invite | null {
  const invite = state.invites.find(i => i.token === token);
  if (!invite) return null;
  if (invite.used) return null;
  if (invite.expiresAt < Date.now()) return null;
  return invite;
}

export function consumeInvite(token: string): void {
  const invite = state.invites.find(i => i.token === token);
  if (invite) {
    invite.used = true;
    save();
  }
}

// --- User management ---

export function createUser(name: string): PasskeyUser {
  if (state.users.some(u => u.name === name)) {
    throw new Error(`User "${name}" already exists`);
  }

  const user: PasskeyUser = {
    name,
    credentials: [],
    createdAt: Date.now(),
    revoked: false,
  };
  state.users.push(user);
  save();
  return user;
}

export function getUser(name: string): PasskeyUser | undefined {
  return state.users.find(u => u.name === name);
}

export function getAllUsers(): PasskeyUser[] {
  return state.users;
}

export function addCredential(name: string, credential: StoredCredential): void {
  const user = state.users.find(u => u.name === name);
  if (!user) throw new Error(`User "${name}" not found`);
  user.credentials.push(credential);
  save();
}

export function updateCredentialCounter(credentialId: string, newCounter: number): void {
  for (const user of state.users) {
    const cred = user.credentials.find(c => c.credentialId === credentialId);
    if (cred) {
      cred.counter = newCounter;
      save();
      return;
    }
  }
}

export function findUserByCredentialId(credentialId: string): PasskeyUser | undefined {
  return state.users.find(u =>
    !u.revoked && u.credentials.some(c => c.credentialId === credentialId)
  );
}

export function revokeUser(name: string): boolean {
  const user = state.users.find(u => u.name === name);
  if (!user) return false;
  user.revoked = true;

  // Also kill all active sessions for this user
  for (const [token, session] of Object.entries(state.sessions)) {
    if (session.name === name) delete state.sessions[token];
  }

  save();
  return true;
}

export function unrevokeUser(name: string): boolean {
  const user = state.users.find(u => u.name === name);
  if (!user) return false;
  user.revoked = false;
  save();
  return true;
}

// --- Challenge store ---

export function storeChallenge(key: string, challenge: string): void {
  challenges.set(key, {
    challenge,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min
  });
}

export function getChallenge(key: string): string | undefined {
  const entry = challenges.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    challenges.delete(key);
    return undefined;
  }
  challenges.delete(key); // one-time use
  return entry.challenge;
}

// --- Session tokens (HMAC-signed cookies) ---

export function createSession(name: string): string {
  const user = state.users.find(u => u.name === name);
  if (user) user.lastUsedAt = Date.now();

  const token = randomBytes(32).toString("base64url");
  state.sessions[token] = {
    name,
    expiresAt: Date.now() + SESSION_MAX_AGE_MS,
  };
  save();

  // Return signed token: token.signature
  const sig = createHmac("sha256", hmacSecret).update(token).digest("base64url");
  return `${token}.${sig}`;
}

export function validateSession(signedToken: string): { name: string } | null {
  const parts = signedToken.split(".");
  if (parts.length !== 2) return null;

  const [token, sig] = parts;
  const expectedSig = createHmac("sha256", hmacSecret).update(token).digest("base64url");

  // Constant-time comparison
  if (sig.length !== expectedSig.length) return null;
  let match = true;
  for (let i = 0; i < sig.length; i++) {
    if (sig[i] !== expectedSig[i]) match = false;
  }
  if (!match) return null;

  const session = state.sessions[token];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    delete state.sessions[token];
    save();
    return null;
  }

  // Check user isn't revoked
  const user = state.users.find(u => u.name === session.name);
  if (!user || user.revoked) return null;

  return { name: session.name };
}

export function revokeSession(signedToken: string): void {
  const parts = signedToken.split(".");
  if (parts.length === 2) {
    delete state.sessions[parts[0]];
    save();
  }
}

/**
 * Reload auth state from disk. Used when CLI modifies auth.json
 * and the running server needs to pick up changes.
 */
export function reloadState(): void {
  if (!authFilePath) return;
  try {
    state = JSON.parse(readFileSync(authFilePath, "utf-8"));
    const now = Date.now();
    for (const [token, session] of Object.entries(state.sessions)) {
      if (session.expiresAt < now) delete state.sessions[token];
    }
  } catch {
    // If file is corrupted or missing, keep current state
  }
}
