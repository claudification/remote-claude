/**
 * WebSocket Client
 * Connects to concentrator with automatic reconnection and offline queuing
 */

import type {
  WrapperMessage,
  ConcentratorMessage,
  SessionMeta,
  SessionEnd,
  HookEvent,
  Heartbeat,
  TerminalData,
  WrapperCapability,
} from "../shared/protocol";
import { DEFAULT_CONCENTRATOR_URL } from "../shared/protocol";

export interface WsClientOptions {
  concentratorUrl?: string;
  concentratorSecret?: string;
  sessionId: string;
  cwd: string;
  model?: string;
  args?: string[];
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (error: Error) => void;
  capabilities?: WrapperCapability[];
  onInput?: (input: string) => void;
  onTerminalAttach?: (cols: number, rows: number) => void;
  onTerminalDetach?: () => void;
  onTerminalInput?: (data: string) => void;
  onTerminalResize?: (cols: number, rows: number) => void;
}

export interface WsClient {
  send: (message: WrapperMessage) => void;
  sendHookEvent: (event: HookEvent) => void;
  sendSessionEnd: (reason: string) => void;
  sendTerminalData: (data: string) => void;
  close: () => void;
  isConnected: () => boolean;
}

/**
 * Create WebSocket client with offline queuing
 */
export function createWsClient(options: WsClientOptions): WsClient {
  const {
    concentratorUrl = DEFAULT_CONCENTRATOR_URL,
    concentratorSecret,
    sessionId,
    cwd,
    model,
    args,
    onConnected,
    onDisconnected,
    onError,
    capabilities,
    onInput,
    onTerminalAttach,
    onTerminalDetach,
    onTerminalInput,
    onTerminalResize,
  } = options;

  let ws: WebSocket | null = null;
  let connected = false;
  let shouldReconnect = true;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;
  const messageQueue: WrapperMessage[] = [];
  let heartbeatInterval: Timer | null = null;

  function connect() {
    try {
      const wsUrl = concentratorSecret
        ? `${concentratorUrl}${concentratorUrl.includes("?") ? "&" : "?"}secret=${encodeURIComponent(concentratorSecret)}`
        : concentratorUrl;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        connected = true;
        reconnectAttempts = 0;

        // Send session metadata with capabilities
        const meta: SessionMeta = {
          type: "meta",
          sessionId,
          cwd,
          startedAt: Date.now(),
          model,
          capabilities,
          args,
        };
        ws!.send(JSON.stringify(meta));

        // Flush queued messages
        while (messageQueue.length > 0) {
          const msg = messageQueue.shift();
          if (msg) {
            ws!.send(JSON.stringify(msg));
          }
        }

        // Start heartbeat
        heartbeatInterval = setInterval(() => {
          if (connected) {
            const heartbeat: Heartbeat = {
              type: "heartbeat",
              sessionId,
              timestamp: Date.now(),
            };
            ws!.send(JSON.stringify(heartbeat));
          }
        }, 30000); // 30 seconds

        onConnected?.();
      };

      ws.onclose = () => {
        connected = false;
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }

        onDisconnected?.();

        // Attempt reconnect
        if (shouldReconnect && reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
          setTimeout(connect, delay);
        }
      };

      ws.onerror = (event) => {
        const error = new Error(`WebSocket error: ${event}`);
        onError?.(error);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as ConcentratorMessage;
          // Handle messages from concentrator
          switch (message.type) {
            case "error":
              onError?.(new Error(message.message));
              break;
            case "input":
              // Forward input to PTY
              onInput?.(message.input);
              break;
            case "terminal_attach":
              onTerminalAttach?.(message.cols, message.rows);
              break;
            case "terminal_detach":
              onTerminalDetach?.();
              break;
            case "terminal_data":
              // Raw terminal input from browser (keystrokes, no mangling)
              onTerminalInput?.(message.data);
              break;
            case "terminal_resize":
              onTerminalResize?.(message.cols, message.rows);
              break;
            case "ack":
              // Acknowledgements - no action needed
              break;
          }
        } catch {
          // Ignore parse errors
        }
      };
    } catch (error) {
      onError?.(error as Error);
      // Attempt reconnect on connection failure
      if (shouldReconnect && reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        setTimeout(connect, delay);
      }
    }
  }

  function send(message: WrapperMessage) {
    if (connected && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      // Queue for later
      messageQueue.push(message);
    }
  }

  function sendHookEvent(event: HookEvent) {
    send(event);
  }

  function sendSessionEnd(reason: string) {
    const endMsg: SessionEnd = {
      type: "end",
      sessionId,
      reason,
      endedAt: Date.now(),
    };
    send(endMsg);
  }

  function sendTerminalData(data: string) {
    const msg: TerminalData = {
      type: "terminal_data",
      sessionId,
      data,
    };
    send(msg);
  }

  function close() {
    shouldReconnect = false;
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    connected = false;
  }

  function isConnected() {
    return connected;
  }

  // Start connection
  connect();

  return {
    send,
    sendHookEvent,
    sendSessionEnd,
    sendTerminalData,
    close,
    isConnected,
  };
}
