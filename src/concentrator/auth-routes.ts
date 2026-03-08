/**
 * WebAuthn Authentication Routes
 *
 * Registration: invite token -> challenge -> passkey creation -> session cookie
 * Authentication: challenge -> passkey assertion -> session cookie
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import {
  validateInvite,
  consumeInvite,
  createUser,
  getUser,
  addCredential,
  storeChallenge,
  getChallenge,
  findUserByCredentialId,
  updateCredentialCounter,
  createSession,
  validateSession,
  revokeSession,
  hasAnyUsers,
  getRpId,
  getRpName,
  getExpectedOrigins,
  type StoredCredential,
} from "./auth";

let rclaudeSecret: string | undefined;

export function setRclaudeSecret(secret: string): void {
  rclaudeSecret = secret;
}

const SESSION_COOKIE_NAME = "concentrator-session";
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60; // 7 days

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function setCookie(signedToken: string): string {
  return `${SESSION_COOKIE_NAME}=${signedToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}`;
}

function clearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function getCookieValue(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

/**
 * Check if a request is authenticated.
 * Returns the user name or null.
 */
export function getAuthenticatedUser(req: Request): string | null {
  const token = getCookieValue(req);
  if (!token) return null;
  const session = validateSession(token);
  return session?.name ?? null;
}

/**
 * Routes that are ALWAYS accessible without authentication.
 * Everything else requires a valid, non-revoked passkey session.
 */
const PUBLIC_AUTH_ROUTES = new Set([
  "/auth/status",
  "/auth/invite/validate",
  "/auth/register/options",
  "/auth/register/verify",
  "/auth/login/options",
  "/auth/login/verify",
]);

/**
 * Auth middleware check. Returns null if authenticated, or a Response to send.
 * Skips auth if no users exist yet (first-time setup).
 *
 * DENY BY DEFAULT. Only explicitly listed routes are public.
 */
export function requireAuth(req: Request): Response | null {
  // No users registered yet = open access (must use invite to register first)
  if (!hasAnyUsers()) return null;

  const url = new URL(req.url);

  // Health check always accessible (for Docker healthcheck / monitoring)
  if (url.pathname === "/health") return null;

  // Specific auth routes needed for login/registration flow (no cookie yet)
  if (PUBLIC_AUTH_ROUTES.has(url.pathname)) return null;

  // WebSocket: rclaude authenticates with shared secret, dashboard with session cookie/token
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const secret = url.searchParams.get("secret");
    if (rclaudeSecret && secret === rclaudeSecret) return null;
    if (getAuthenticatedUser(req)) return null;
    const token = url.searchParams.get("token");
    if (token && validateSession(token)) return null;
    return new Response("Unauthorized", { status: 401 });
  }

  // Everything else requires authentication
  const isAuthenticated = getAuthenticatedUser(req);

  if (isAuthenticated) return null;

  // Not authenticated - serve SPA for HTML navigation (login UI), block everything else
  const accept = req.headers.get("accept") || "";
  if (accept.includes("text/html") && !url.pathname.startsWith("/auth/")) {
    return null; // SPA handles showing login screen
  }

  return jsonResponse({ error: "Unauthorized" }, 401);
}

/**
 * Handle auth API routes. Returns a Response or null if not an auth route.
 */
export async function handleAuthRoute(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;

  // --- Status ---
  if (path === "/auth/status" && req.method === "GET") {
    const user = getAuthenticatedUser(req);
    return jsonResponse({
      authenticated: !!user,
      name: user,
      hasUsers: hasAnyUsers(),
    });
  }

  // --- Validate invite ---
  if (path === "/auth/invite/validate" && req.method === "POST") {
    const { token } = await req.json() as { token: string };
    const invite = validateInvite(token);
    if (!invite) {
      return jsonResponse({ valid: false, error: "Invalid or expired invite" }, 400);
    }
    return jsonResponse({ valid: true, name: invite.name });
  }

  // --- Registration: generate options ---
  if (path === "/auth/register/options" && req.method === "POST") {
    const { token } = await req.json() as { token: string };
    const invite = validateInvite(token);
    if (!invite) {
      return jsonResponse({ error: "Invalid or expired invite" }, 400);
    }

    const options = await generateRegistrationOptions({
      rpName: getRpName(),
      rpID: getRpId(),
      userName: invite.name,
      userDisplayName: invite.name,
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "preferred",
      },
    });

    // Store challenge keyed by invite token
    storeChallenge(`reg:${token}`, options.challenge);

    return jsonResponse(options);
  }

  // --- Registration: verify ---
  if (path === "/auth/register/verify" && req.method === "POST") {
    const { token, response } = await req.json() as { token: string; response: any };
    const invite = validateInvite(token);
    if (!invite) {
      return jsonResponse({ error: "Invalid or expired invite" }, 400);
    }

    const expectedChallenge = getChallenge(`reg:${token}`);
    if (!expectedChallenge) {
      return jsonResponse({ error: "Challenge expired. Try again." }, 400);
    }

    try {
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedRPID: getRpId(),
        expectedOrigin: getExpectedOrigins(),
      });

      if (!verification.verified || !verification.registrationInfo) {
        return jsonResponse({ error: "Verification failed" }, 400);
      }

      const { credential } = verification.registrationInfo;

      // Create user + store credential
      let user = getUser(invite.name);
      if (!user) {
        user = createUser(invite.name);
      }

      const storedCred: StoredCredential = {
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: response.response?.transports as AuthenticatorTransportFuture[] | undefined,
        registeredAt: Date.now(),
      };

      addCredential(invite.name, storedCred);
      consumeInvite(token);

      // Create session
      const sessionToken = createSession(invite.name);

      return new Response(JSON.stringify({ verified: true, name: invite.name }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": setCookie(sessionToken),
        },
      });
    } catch (error) {
      return jsonResponse({ error: `Registration failed: ${error}` }, 400);
    }
  }

  // --- Authentication: generate options ---
  if (path === "/auth/login/options" && req.method === "POST") {
    const options = await generateAuthenticationOptions({
      rpID: getRpId(),
      allowCredentials: [], // Empty = discoverable credentials mode (no QR code)
      userVerification: "preferred",
    });

    // Store challenge with a random key, return key to client
    const challengeKey = crypto.randomUUID();
    storeChallenge(`auth:${challengeKey}`, options.challenge);

    return jsonResponse({ ...options, challengeKey });
  }

  // --- Authentication: verify ---
  if (path === "/auth/login/verify" && req.method === "POST") {
    const { challengeKey, response } = await req.json() as { challengeKey: string; response: any };

    const expectedChallenge = getChallenge(`auth:${challengeKey}`);
    if (!expectedChallenge) {
      return jsonResponse({ error: "Challenge expired. Try again." }, 400);
    }

    // Find the credential
    const credentialId = response.id;
    const user = findUserByCredentialId(credentialId);
    if (!user) {
      return jsonResponse({ error: "Unknown credential" }, 400);
    }

    const credential = user.credentials.find(c => c.credentialId === credentialId);
    if (!credential) {
      return jsonResponse({ error: "Credential not found" }, 400);
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedRPID: getRpId(),
        expectedOrigin: getExpectedOrigins(),
        credential: {
          id: credentialId,
          publicKey: Buffer.from(credential.publicKey, "base64url"),
          counter: credential.counter,
          transports: credential.transports,
        },
      });

      if (!verification.verified) {
        return jsonResponse({ error: "Authentication failed" }, 400);
      }

      // Update counter
      updateCredentialCounter(credentialId, verification.authenticationInfo.newCounter);

      // Create session
      const sessionToken = createSession(user.name);

      return new Response(JSON.stringify({ verified: true, name: user.name }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": setCookie(sessionToken),
        },
      });
    } catch (error) {
      return jsonResponse({ error: `Authentication failed: ${error}` }, 400);
    }
  }

  // --- Logout ---
  if (path === "/auth/logout" && req.method === "POST") {
    const token = getCookieValue(req);
    if (token) revokeSession(token);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": clearCookie(),
      },
    });
  }

  return null;
}
