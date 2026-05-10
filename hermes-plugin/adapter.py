"""
Claudwerk gateway adapter for Hermes Agent.

Connects to the rclaude broker via a persistent WebSocket, registering as a
"hermes" gateway. The broker forwards user input for Hermes conversations to
this adapter, which dispatches to the Hermes agent and sends back transcript
entries, streaming deltas, and tool call progress.

Drop into ~/.hermes/plugins/claudwerk/ and restart the gateway.
Requires: CLAUDWERK_BROKER_URL, CLAUDWERK_ADAPTER_SECRET env vars.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.config import Platform, PlatformConfig

logger = logging.getLogger("claudwerk")

PROTOCOL_VERSION = 2
AGENT_HOST_TYPE = "hermes"
HEARTBEAT_INTERVAL = 30
MAX_RECONNECT_DELAY = 60
SESSION_MAP_FILE = "session_map.json"


class ClaudwerkAdapter(BasePlatformAdapter):
    """Gateway adapter connecting Hermes to the rclaude broker via WebSocket."""

    def __init__(self, config: PlatformConfig, **kwargs: Any):
        super().__init__(config=config, platform=Platform("webhook"), **kwargs)
        extra = config.extra or {}
        self.broker_url: str = (
            os.getenv("CLAUDWERK_BROKER_URL") or extra.get("broker_url", "")
        )
        self.secret: str = (
            os.getenv("CLAUDWERK_ADAPTER_SECRET") or extra.get("secret", "")
        )
        self.project: str = (
            os.getenv("CLAUDWERK_DEFAULT_PROJECT") or extra.get("project", "hermes://gateway")
        )
        self.ws: Any = None
        self._receive_task: Optional[asyncio.Task[None]] = None
        self._heartbeat_task: Optional[asyncio.Task[None]] = None
        self._reconnect_task: Optional[asyncio.Task[None]] = None
        self._reconnect_delay = 1.0
        self._should_run = False
        # Captured at connect() so plugin hooks (which fire from sync
        # agent threads) can schedule WS sends back onto the gateway's
        # event loop via run_coroutine_threadsafe.
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        # conversationId -> chat_id mapping (broker conversations -> hermes sessions)
        self._conv_to_chat: Dict[str, str] = {}
        # chat_id -> conversationId reverse mapping
        self._chat_to_conv: Dict[str, str] = {}

        # Active processing state per conversation
        self._active_turns: Dict[str, str] = {}  # conversationId -> current assistant uuid

        # Length of cumulative streaming text already pushed to the
        # broker per conversation. The gateway stream consumer sends
        # the full accumulated buffer on each edit_message call; we
        # only forward the suffix that hasn't been broadcast yet so
        # the dashboard's stream_delta handler doesn't duplicate text.
        self._stream_emitted_len: Dict[str, int] = {}

        self._session_map_path = Path(
            os.getenv("HERMES_HOME", "/opt/data")
        ) / "plugins" / "claudwerk" / SESSION_MAP_FILE

        self._load_session_map()

    # ─── Abstract method implementations ────────────────────────────────

    async def connect(self) -> bool:
        if not self.broker_url or not self.secret:
            logger.error("Missing CLAUDWERK_BROKER_URL or CLAUDWERK_ADAPTER_SECRET")
            return False

        self._should_run = True
        self._loop = asyncio.get_running_loop()
        return await self._connect_ws()

    async def disconnect(self) -> None:
        self._should_run = False
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
        if self._reconnect_task:
            self._reconnect_task.cancel()
        if self._receive_task:
            self._receive_task.cancel()
        if self.ws:
            try:
                await self.ws.close()
            except Exception:
                pass
        self._save_session_map()
        self._mark_disconnected()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        conv_id = self._chat_to_conv.get(chat_id)
        if not conv_id:
            return SendResult(success=False, error="No conversation for chat_id")

        entry_uuid = str(uuid.uuid4())
        entry = {
            "type": "assistant",
            "uuid": entry_uuid,
            "timestamp": _now_iso(),
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": content}],
            },
        }

        await self._send_json({
            "type": "transcript_entries",
            "conversationId": conv_id,
            "entries": [entry],
            "isInitial": False,
        })

        await self._send_json({
            "type": "conversation_status",
            "conversationId": conv_id,
            "status": "idle",
        })

        self._active_turns.pop(conv_id, None)
        return SendResult(success=True, message_id=entry_uuid)

    async def send_typing(self, chat_id: str, metadata: Any = None) -> None:
        conv_id = self._chat_to_conv.get(chat_id)
        if conv_id:
            await self._send_json({
                "type": "conversation_status",
                "conversationId": conv_id,
                "status": "active",
            })

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "dm"}

    # ─── Streaming via edit_message ─────────────────────────────────────

    REQUIRES_EDIT_FINALIZE = True

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
    ) -> SendResult:
        conv_id = self._chat_to_conv.get(chat_id)
        if not conv_id:
            return SendResult(success=False)

        # The stream consumer sends the full cumulative buffer on each
        # call. The dashboard's content_block_delta handler appends
        # delta.text to its buffer, so we MUST send only the suffix
        # since the last edit -- not the whole content -- otherwise
        # the dashboard duplicates text.
        full = content or ""
        already = self._stream_emitted_len.get(conv_id, 0)
        if len(full) > already:
            suffix = full[already:]
            self._stream_emitted_len[conv_id] = len(full)
            await self._send_json({
                "type": "stream_delta",
                "conversationId": conv_id,
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": suffix},
                },
            })
        elif len(full) < already:
            # Buffer reset (new segment after tool break). Reset and
            # emit the full content as one delta.
            self._stream_emitted_len[conv_id] = len(full)
            if full:
                await self._send_json({
                    "type": "stream_delta",
                    "conversationId": conv_id,
                    "event": {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "text_delta", "text": full},
                    },
                })

        if finalize:
            await self._send_json({
                "type": "stream_delta",
                "conversationId": conv_id,
                "event": {"type": "content_block_stop", "index": 0},
            })
            await self._send_json({
                "type": "stream_delta",
                "conversationId": conv_id,
                "event": {"type": "message_stop"},
            })
            self._stream_emitted_len.pop(conv_id, None)

        return SendResult(success=True, message_id=message_id)

    # ─── Processing lifecycle hooks ─────────────────────────────────────

    async def on_processing_start(self, event: MessageEvent) -> None:
        chat_id = event.source.chat_id if event.source else None
        if not chat_id:
            return
        conv_id = self._chat_to_conv.get(chat_id)
        if conv_id:
            # New turn -- reset streaming-suffix tracker so the first
            # text_delta of this turn is emitted in full instead of
            # being mistakenly collapsed against last turn's length.
            self._stream_emitted_len.pop(conv_id, None)
            # Signal message_start for streaming
            await self._send_json({
                "type": "stream_delta",
                "conversationId": conv_id,
                "event": {
                    "type": "message_start",
                    "message": {"role": "assistant"},
                },
            })
            await self._send_json({
                "type": "stream_delta",
                "conversationId": conv_id,
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "text", "text": ""},
                },
            })

    # ─── WebSocket connection ───────────────────────────────────────────

    async def _connect_ws(self) -> bool:
        try:
            import websockets
        except ImportError:
            logger.error("websockets package not installed")
            self._set_fatal_error("MISSING_DEP", "pip install websockets", retryable=False)
            return False

        try:
            url = f"{self.broker_url}?secret={self.secret}"
            self.ws = await websockets.connect(
                url, ping_interval=30, ping_timeout=10,
            )
            logger.info("Connected to broker at %s", self.broker_url.split("?")[0])
        except Exception as e:
            logger.error("Connection failed: %s", e)
            if self._should_run:
                self._schedule_reconnect()
            return False

        # Register as gateway
        await self._send_json({
            "type": "gateway_register",
            "protocolVersion": PROTOCOL_VERSION,
            "agentHostType": AGENT_HOST_TYPE,
            "version": "claudwerk/1.0.0",
            "capabilities": ["headless", "channel"],
        })

        self._reconnect_delay = 1.0
        self._receive_task = asyncio.create_task(self._receive_loop())
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        self._mark_connected()
        return True

    async def _receive_loop(self) -> None:
        import websockets

        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                    await self._handle_broker_message(msg)
                except json.JSONDecodeError:
                    logger.warning("Non-JSON message from broker")
                except Exception as e:
                    logger.error("Error handling broker message: %s", e, exc_info=True)
        except websockets.ConnectionClosed as e:
            logger.warning("Broker connection closed: %s", e)
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.error("Receive loop error: %s", e, exc_info=True)
        finally:
            self._mark_disconnected()
            if self._should_run:
                self._schedule_reconnect()

    async def _heartbeat_loop(self) -> None:
        try:
            while self._should_run:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                await self._send_json({
                    "type": "gateway_heartbeat",
                    "agentHostType": AGENT_HOST_TYPE,
                    "timestamp": int(time.time() * 1000),
                })
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error("Heartbeat error: %s", e)

    def _schedule_reconnect(self) -> None:
        if self._reconnect_task and not self._reconnect_task.done():
            return
        self._reconnect_task = asyncio.create_task(self._reconnect())

    async def _reconnect(self) -> None:
        while self._should_run:
            delay = min(self._reconnect_delay, MAX_RECONNECT_DELAY)
            logger.info("Reconnecting in %.1fs...", delay)
            await asyncio.sleep(delay)
            self._reconnect_delay = min(self._reconnect_delay * 2, MAX_RECONNECT_DELAY)

            if await self._connect_ws():
                logger.info("Reconnected successfully")
                return

    # ─── Broker message handling ────────────────────────────────────────

    async def _handle_broker_message(self, msg: Dict[str, Any]) -> None:
        msg_type = msg.get("type")

        if msg_type == "input":
            await self._handle_input(msg)
        elif msg_type == "interrupt":
            await self._handle_interrupt(msg)
        elif msg_type == "control":
            await self._handle_control(msg)
        elif msg_type == "terminate_conversation":
            self._handle_terminate(msg)
        elif msg_type == "gateway_register_result":
            if msg.get("ok"):
                logger.info("Gateway registered: %s", msg.get("agentHostType"))
            else:
                logger.error("Gateway registration failed: %s", msg.get("error"))
        elif msg_type == "protocol_upgrade_required":
            logger.error(
                "Protocol upgrade required: %s (have v%d, need v%d)",
                msg.get("message"),
                PROTOCOL_VERSION,
                msg.get("requiredVersion"),
            )
            self._should_run = False
        elif msg_type == "ack":
            pass  # acknowledged
        else:
            logger.debug("Unhandled broker message type: %s", msg_type)

    async def _handle_input(self, msg: Dict[str, Any]) -> None:
        conv_id = msg.get("conversationId", "")
        text = msg.get("input", "")
        if not conv_id or not text:
            return

        # Get or create Hermes session for this conversation
        chat_id = self._conv_to_chat.get(conv_id)
        if not chat_id:
            chat_id = f"claudwerk-{conv_id[:12]}"
            self._conv_to_chat[conv_id] = chat_id
            self._chat_to_conv[chat_id] = conv_id
            self._save_session_map()
            logger.info("New conversation: %s -> %s", conv_id[:8], chat_id)

        # Signal active
        await self._send_json({
            "type": "conversation_status",
            "conversationId": conv_id,
            "status": "active",
        })

        # Dispatch to Hermes agent via BasePlatformAdapter
        source = self.build_source(
            chat_id=chat_id,
            chat_name="Dashboard",
            chat_type="dm",
            user_id="dashboard",
            user_name="Dashboard User",
        )
        event = MessageEvent(
            text=text,
            message_type=MessageType.TEXT,
            source=source,
            message_id=str(uuid.uuid4()),
            timestamp=datetime.now(timezone.utc),
        )
        await self.handle_message(event)

    async def _handle_interrupt(self, msg: Dict[str, Any]) -> None:
        conv_id = msg.get("conversationId", "")
        chat_id = self._conv_to_chat.get(conv_id)
        if chat_id:
            session_key = f"claudwerk:{chat_id}:dm"
            event = self._active_sessions.get(session_key)
            if event:
                event.set()
                logger.info("Interrupted conversation %s", conv_id[:8])

    async def _handle_control(self, msg: Dict[str, Any]) -> None:
        verb = msg.get("verb")
        conv_id = msg.get("conversationId", "")

        if verb == "clear":
            chat_id = self._conv_to_chat.get(conv_id)
            if chat_id:
                del self._conv_to_chat[conv_id]
                del self._chat_to_conv[chat_id]
                new_chat_id = f"claudwerk-{conv_id[:12]}-{int(time.time())}"
                self._conv_to_chat[conv_id] = new_chat_id
                self._chat_to_conv[new_chat_id] = conv_id
                self._save_session_map()
                await self._send_json({
                    "type": "conversation_status",
                    "conversationId": conv_id,
                    "status": "idle",
                })
                logger.info("Cleared conversation %s", conv_id[:8])
        elif verb == "quit":
            self._handle_terminate(msg)

    def _handle_terminate(self, msg: Dict[str, Any]) -> None:
        conv_id = msg.get("conversationId", "")
        chat_id = self._conv_to_chat.pop(conv_id, None)
        if chat_id:
            self._chat_to_conv.pop(chat_id, None)
            self._save_session_map()
            logger.info("Terminated conversation %s", conv_id[:8])

    # ─── JSON send helper ───────────────────────────────────────────────

    async def _send_json(self, data: Dict[str, Any]) -> None:
        if self.ws:
            try:
                await self.ws.send(json.dumps(data))
            except Exception as e:
                logger.warning("Send failed: %s", e)

    # ─── Session persistence ────────────────────────────────────────────

    def _load_session_map(self) -> None:
        try:
            if self._session_map_path.exists():
                data = json.loads(self._session_map_path.read_text())
                self._conv_to_chat = data.get("conv_to_chat", {})
                self._chat_to_conv = data.get("chat_to_conv", {})
                logger.info("Loaded %d session mappings", len(self._conv_to_chat))
        except Exception as e:
            logger.warning("Failed to load session map: %s", e)

    def _save_session_map(self) -> None:
        try:
            self._session_map_path.parent.mkdir(parents=True, exist_ok=True)
            self._session_map_path.write_text(json.dumps({
                "conv_to_chat": self._conv_to_chat,
                "chat_to_conv": self._chat_to_conv,
            }))
        except Exception as e:
            logger.warning("Failed to save session map: %s", e)


# ─── Plugin hooks for tool call visibility ──────────────────────────────

_adapter_instance: Optional[ClaudwerkAdapter] = None


def _schedule_on_adapter_loop(adapter: ClaudwerkAdapter, coro: Any) -> None:
    """Bridge a sync hook to the adapter's async loop.

    Hermes's invoke_hook calls hook callbacks synchronously; if a callback
    is `async def`, the returned coroutine is dropped (RuntimeWarning:
    coroutine was never awaited). We work around this by registering
    sync hooks that schedule the actual WS send via
    run_coroutine_threadsafe onto the gateway loop captured at connect.
    """
    loop = getattr(adapter, "_loop", None)
    if loop is None or not loop.is_running():
        coro.close()
        return
    try:
        asyncio.run_coroutine_threadsafe(coro, loop)
    except RuntimeError as e:
        logger.debug("Could not schedule coro on adapter loop: %s", e)
        coro.close()


async def _async_pre_tool_call(adapter: ClaudwerkAdapter, **kwargs: Any) -> None:
    if not adapter.ws:
        return

    tool_name = kwargs.get("tool_name", "unknown")
    args = kwargs.get("args", {})
    session_id = kwargs.get("session_id", "")

    # Find the conversationId for this session
    conv_id = None
    for chat_id, cid in adapter._chat_to_conv.items():
        if session_id and chat_id in session_id:
            conv_id = cid
            break

    if not conv_id:
        return None

    tool_use_id = kwargs.get("tool_call_id") or _short_id()

    # Match CC's transcript shape: an `assistant` entry whose message
    # carries a tool_use content block. The dashboard renders this as a
    # collapsible tool card -- a `progress` entry with the same content
    # blocks would render as a small inline preview, not a real card.
    entry = {
        "type": "assistant",
        "uuid": str(uuid.uuid4()),
        "timestamp": _now_iso(),
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": tool_use_id,
                "name": tool_name,
                "input": args if isinstance(args, dict) else {"args": str(args)},
            }],
        },
    }

    await adapter._send_json({
        "type": "transcript_entries",
        "conversationId": conv_id,
        "entries": [entry],
        "isInitial": False,
    })
    return None


async def _async_post_tool_call(adapter: ClaudwerkAdapter, **kwargs: Any) -> None:
    if not adapter.ws:
        return

    session_id = kwargs.get("session_id", "")

    conv_id = None
    for chat_id, cid in adapter._chat_to_conv.items():
        if session_id and chat_id in session_id:
            conv_id = cid
            break

    if not conv_id:
        return

    result = kwargs.get("result", "")
    if not isinstance(result, str):
        try:
            result = json.dumps(result, default=str)
        except Exception:
            result = str(result)

    tool_use_id = kwargs.get("tool_call_id") or ""

    # Match CC's pattern: tool results live on a `user`-type entry whose
    # message carries a tool_result content block. `toolUseResult` at
    # the top level mirrors what CC writes to JSONL so dashboards that
    # rendered against the original schema also see the result.
    entry = {
        "type": "user",
        "uuid": str(uuid.uuid4()),
        "timestamp": _now_iso(),
        "sourceToolUseID": tool_use_id,
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": result[:2000],
            }],
        },
        "toolUseResult": result[:2000],
    }

    await adapter._send_json({
        "type": "transcript_entries",
        "conversationId": conv_id,
        "entries": [entry],
        "isInitial": False,
    })


# Hermes's invoke_hook calls callbacks synchronously and drops returned
# coroutines. These thin sync shims schedule the async work onto the
# adapter's event loop via run_coroutine_threadsafe.
def _on_pre_tool_call(**kwargs: Any) -> None:
    adapter = _adapter_instance
    if not adapter:
        return
    _schedule_on_adapter_loop(adapter, _async_pre_tool_call(adapter, **kwargs))


def _on_post_tool_call(**kwargs: Any) -> None:
    adapter = _adapter_instance
    if not adapter:
        return
    _schedule_on_adapter_loop(adapter, _async_post_tool_call(adapter, **kwargs))


# ─── Utility ────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _short_id() -> str:
    return uuid.uuid4().hex[:16]


# ─── Plugin registration ────────────────────────────────────────────────

def check_requirements() -> bool:
    return bool(
        os.getenv("CLAUDWERK_BROKER_URL")
        and os.getenv("CLAUDWERK_ADAPTER_SECRET")
    )


def validate_config(config: Any) -> bool:
    extra = getattr(config, "extra", {}) or {}
    has_url = bool(os.getenv("CLAUDWERK_BROKER_URL") or extra.get("broker_url"))
    has_secret = bool(os.getenv("CLAUDWERK_ADAPTER_SECRET") or extra.get("secret"))
    return has_url and has_secret


def _env_enablement() -> Optional[dict]:
    url = os.getenv("CLAUDWERK_BROKER_URL", "").strip()
    secret = os.getenv("CLAUDWERK_ADAPTER_SECRET", "").strip()
    if not url or not secret:
        return None
    seed: dict = {"broker_url": url, "secret": secret}
    project = os.getenv("CLAUDWERK_DEFAULT_PROJECT", "").strip()
    if project:
        seed["project"] = project
    return seed


def register(ctx: Any) -> None:
    global _adapter_instance

    def _factory(cfg: PlatformConfig) -> ClaudwerkAdapter:
        global _adapter_instance
        adapter = ClaudwerkAdapter(cfg)
        _adapter_instance = adapter
        return adapter

    ctx.register_platform(
        name="claudwerk",
        label="Claudwerk",
        adapter_factory=_factory,
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=["CLAUDWERK_BROKER_URL", "CLAUDWERK_ADAPTER_SECRET"],
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="CLAUDWERK_DEFAULT_PROJECT",
        max_message_length=100000,
        platform_hint=(
            "You are chatting via the Claudwerk dashboard. "
            "Rich formatting (markdown, code blocks) is fully supported."
        ),
        emoji="",
    )

    # Register tool hooks for visibility in the dashboard
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
