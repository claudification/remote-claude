/**
 * REST API for Concentrator
 * Provides endpoints for querying session data
 */

import type { SessionStore } from "./session-store";
import type { Session, SendInput } from "../shared/protocol";
import { UI_HTML } from "./ui";

// Image hash registry - maps hash to local file path
const imageRegistry = new Map<string, string>();

// Simple hash function for file paths
function hashPath(path: string): string {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    const char = path.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Register an image path and return its hash
 */
export function registerImage(path: string): string {
  const hash = hashPath(path);
  imageRegistry.set(hash, path);
  return hash;
}

/**
 * Get image path from hash
 */
export function getImagePath(hash: string): string | undefined {
  return imageRegistry.get(hash);
}

// Image extensions we recognize
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'svg'];

/**
 * Process a transcript entry to find and register images
 * Returns the entry with an `images` field added containing registered image info
 */
function processImagesInEntry(entry: any): any {
  const images: Array<{ hash: string; ext: string; url: string; originalPath: string }> = [];

  // Pattern: [Image: source: /path/to/file.ext]
  const imagePattern = /\[Image:\s*source:\s*([^\]]+)\]/gi;

  function scanValue(value: any): void {
    if (typeof value === 'string') {
      let match;
      while ((match = imagePattern.exec(value)) !== null) {
        const imagePath = match[1].trim();
        const ext = imagePath.split('.').pop()?.toLowerCase() || 'png';
        if (IMAGE_EXTENSIONS.includes(ext)) {
          const hash = registerImage(imagePath);
          images.push({
            hash,
            ext,
            url: `/file/${hash}.${ext}`,
            originalPath: imagePath,
          });
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(scanValue);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(scanValue);
    }
  }

  scanValue(entry);

  if (images.length > 0) {
    return { ...entry, images };
  }
  return entry;
}

export interface ApiOptions {
  sessionStore: SessionStore;
  webDir?: string;
}

// Build a map of embedded files for quick lookup
type EmbeddedBlob = Blob & { name: string };
const embeddedFiles = new Map<string, Blob>();
const hasEmbeddedWeb = typeof Bun !== "undefined" && (Bun.embeddedFiles as EmbeddedBlob[])?.length > 0;

if (hasEmbeddedWeb) {
  for (const blob of Bun.embeddedFiles as EmbeddedBlob[]) {
    // Remove hash from filename: "index-a1b2c3d4.html" -> "index.html"
    const name = blob.name.replace(/-[a-f0-9]+\./, ".");
    embeddedFiles.set(name, blob);
    // Also map with lib/ prefix for assets
    if (blob.name.startsWith("lib/") || blob.name.includes("/lib/")) {
      const libPath = blob.name.includes("/lib/")
        ? blob.name.substring(blob.name.indexOf("/lib/") + 1)
        : blob.name;
      embeddedFiles.set(libPath, blob);
    }
  }
}

function getMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    heic: "image/heic",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    pdf: "application/pdf",
  };
  return mimeTypes[ext || ""] || "application/octet-stream";
}

interface SessionSummary {
  id: string;
  cwd: string;
  model?: string;
  status: Session["status"];
  startedAt: number;
  lastActivity: number;
  eventCount: number;
  lastEvent?: {
    hookEvent: string;
    timestamp: number;
  };
}

/**
 * Create API request handler
 */
export function createApiHandler(options: ApiOptions) {
  const { sessionStore, webDir } = options;

  function sessionToSummary(session: Session): SessionSummary {
    const lastEvent = session.events[session.events.length - 1];
    return {
      id: session.id,
      cwd: session.cwd,
      model: session.model,
      status: session.status,
      startedAt: session.startedAt,
      lastActivity: session.lastActivity,
      eventCount: session.events.length,
      lastEvent: lastEvent
        ? {
            hookEvent: lastEvent.hookEvent,
            timestamp: lastEvent.timestamp,
          }
        : undefined,
    };
  }

  return async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Serve embedded web dashboard if available
    if (hasEmbeddedWeb && req.method === "GET") {
      // Serve index.html at root
      if (path === "/" || path === "/index.html") {
        const indexHtml = embeddedFiles.get("index.html");
        if (indexHtml) {
          return new Response(indexHtml, {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
          });
        }
      }

      // Serve other embedded assets
      const assetPath = path.startsWith("/") ? path.slice(1) : path;
      const asset = embeddedFiles.get(assetPath);
      if (asset) {
        return new Response(asset, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": getMimeType(assetPath),
            "Cache-Control": assetPath.startsWith("lib/") ? "public, max-age=31536000, immutable" : "no-cache",
          },
        });
      }

      // SPA fallback - serve index.html for unknown paths (except API routes)
      if (!path.startsWith("/sessions") && !path.startsWith("/health") && !path.startsWith("/api")) {
        const indexHtml = embeddedFiles.get("index.html");
        if (indexHtml) {
          return new Response(indexHtml, {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
          });
        }
      }
    }

    // Serve from webDir if specified
    if (webDir && req.method === "GET") {
      const filePath = path === "/" ? "/index.html" : path;
      const fullPath = `${webDir}${filePath}`;

      try {
        const file = Bun.file(fullPath);
        if (await file.exists()) {
          const isAsset = filePath.startsWith("/assets/") || filePath.startsWith("/lib/");
          return new Response(file, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": getMimeType(filePath),
              "Cache-Control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
            },
          });
        }

        // SPA fallback - serve index.html for unknown paths (except API routes)
        if (!path.startsWith("/sessions") && !path.startsWith("/health") && !path.startsWith("/api")) {
          const indexFile = Bun.file(`${webDir}/index.html`);
          if (await indexFile.exists()) {
            return new Response(indexFile, {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
            });
          }
        }
      } catch {
        // File not found, continue to other handlers
      }
    }

    // Fallback UI at root (when no embedded web or webDir)
    if ((path === "/" || path === "/ui") && req.method === "GET" && !hasEmbeddedWeb && !webDir) {
      return new Response(UI_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Health check
    if (path === "/health") {
      return new Response("ok", {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/plain" },
      });
    }

    // Serve registered images by hash: /file/{hash}.ext
    const fileMatch = path.match(/^\/file\/([a-z0-9]+)(?:\.[a-z]+)?$/i);
    if (fileMatch && req.method === "GET") {
      const hash = fileMatch[1];
      const imagePath = getImagePath(hash);

      if (!imagePath) {
        return new Response(JSON.stringify({ error: "Image not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        const file = Bun.file(imagePath);
        if (!(await file.exists())) {
          return new Response(JSON.stringify({ error: "File not found on disk" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        return new Response(file, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": getMimeType(imagePath),
            "Cache-Control": "public, max-age=3600",
          },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: `Failed to serve file: ${error}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // List all sessions
    if (path === "/sessions" && req.method === "GET") {
      const activeOnly = url.searchParams.get("active") === "true";
      const sessions = activeOnly
        ? sessionStore.getActiveSessions()
        : sessionStore.getAllSessions();

      const summaries = sessions.map(sessionToSummary);

      return new Response(JSON.stringify(summaries, null, 2), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get session by ID
    const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      const sessionId = sessionMatch[1];
      const session = sessionStore.getSession(sessionId);

      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(sessionToSummary(session), null, 2), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get session events
    const eventsMatch = path.match(/^\/sessions\/([^/]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const sessionId = eventsMatch[1];
      const limit = parseInt(url.searchParams.get("limit") || "0", 10);
      const since = parseInt(url.searchParams.get("since") || "0", 10);
      const events = sessionStore.getSessionEvents(sessionId, limit || undefined, since || undefined);

      if (events.length === 0 && !sessionStore.getSession(sessionId)) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(events, null, 2), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get session transcript (tail)
    const transcriptMatch = path.match(/^\/sessions\/([^/]+)\/transcript$/);
    if (transcriptMatch && req.method === "GET") {
      const sessionId = transcriptMatch[1];
      const session = sessionStore.getSession(sessionId);

      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!session.transcriptPath) {
        return new Response(JSON.stringify({ error: "No transcript path available" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        const file = Bun.file(session.transcriptPath);
        if (!(await file.exists())) {
          return new Response(JSON.stringify({ error: "Transcript file not found" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const text = await file.text();
        const lines = text.trim().split("\n").filter(Boolean);

        // Parse JSONL - get last N entries
        const limit = parseInt(url.searchParams.get("limit") || "20", 10);
        const entries = lines.slice(-limit).map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(Boolean);

        // Process entries to find and register images
        const processedEntries = entries.map((entry: any) => processImagesInEntry(entry));

        return new Response(JSON.stringify(processedEntries, null, 2), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: `Failed to read transcript: ${error}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Send input to session
    const inputMatch = path.match(/^\/sessions\/([^/]+)\/input$/);
    if (inputMatch && req.method === "POST") {
      const sessionId = inputMatch[1];
      const session = sessionStore.getSession(sessionId);

      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (session.status === "ended") {
        return new Response(JSON.stringify({ error: "Session has ended" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const ws = sessionStore.getSessionSocket(sessionId);
      if (!ws) {
        return new Response(JSON.stringify({ error: "Session not connected" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        const body = await req.json() as { input: string };
        if (!body.input || typeof body.input !== "string") {
          return new Response(JSON.stringify({ error: "Missing input field" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const inputMsg: SendInput = {
          type: "input",
          sessionId,
          input: body.input,
        };
        ws.send(JSON.stringify(inputMsg));

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: `Failed to send input: ${error}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  };
}
