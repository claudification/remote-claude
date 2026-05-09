"""
Claudwerk platform adapter for Hermes Agent.

Connects to the Claudwerk broker via WebSocket, enabling Hermes conversations
to appear in the control panel alongside coding sessions. Bidirectional:
- User messages from control panel -> Hermes agent
- Hermes responses -> transcript entries in control panel
- Proactive messages (cron, events) -> pushed to control panel

Phase 2 adapter -- for v1, the broker proxies to Hermes API directly.
Drop into ~/.hermes/plugins/claudwerk/ and restart the gateway.
"""

import asyncio
import json
import os
import uuid
from datetime import datetime, timezone

import websockets

from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.config import Platform, PlatformConfig


PROTOCOL_VERSION = 2
AGENT_HOST_TYPE = "hermes"
DEFAULT_PROJECT = "hermes://default"


class ClaudwerkAdapter(BasePlatformAdapter):
    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("claudwerk"))
        extra = config.extra or {}
        self.broker_url = os.getenv("CLAUDWERK_BROKER_URL") or extra.get(
            "broker_url", ""
        )
        self.secret = os.getenv("CLAUDWERK_ADAPTER_SECRET") or extra.get("secret", "")
        self.project = os.getenv("CLAUDWERK_DEFAULT_PROJECT") or extra.get(
            "project", DEFAULT_PROJECT
        )
        self.ws = None
        self._conversations = {}  # chat_id -> conversationId mapping
        self._receive_task = None

    async def connect(self) -> bool:
        if not self.broker_url or not self.secret:
            return False

        try:
            url = f"{self.broker_url}?secret={self.secret}"
            self.ws = await websockets.connect(
                url, ping_interval=30, ping_timeout=10
            )
            self._receive_task = asyncio.create_task(self._receive_loop())
            self._mark_connected()
            return True
        except Exception as e:
            print(f"[claudwerk] Connection failed: {e}")
            return False

    async def disconnect(self) -> None:
        if self._receive_task:
            self._receive_task.cancel()
        if self.ws:
            await self.ws.close()
        self._mark_disconnected()

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        """Send Hermes response to broker as transcript entry."""
        conv_id = self._get_or_create_conversation(chat_id)

        entry = {
            "type": "assistant",
            "uuid": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": content}],
            },
        }

        await self._send_json(
            {
                "type": "transcript_entries",
                "conversationId": conv_id,
                "entries": [entry],
                "isInitial": False,
            }
        )

        # Signal idle after response
        await self._send_json(
            {
                "type": "conversation_status",
                "conversationId": conv_id,
                "status": "idle",
            }
        )

        return SendResult(success=True, message_id=entry["uuid"])

    async def send_typing(self, chat_id):
        """Signal active status when Hermes is thinking."""
        conv_id = self._conversations.get(chat_id)
        if conv_id:
            await self._send_json(
                {
                    "type": "conversation_status",
                    "conversationId": conv_id,
                    "status": "active",
                }
            )

    async def get_chat_info(self, chat_id):
        return {"name": chat_id, "type": "dm"}

    # --- Internal methods ---

    def _get_or_create_conversation(self, chat_id):
        """Map Hermes chat_id to Claudwerk conversationId."""
        if chat_id not in self._conversations:
            conv_id = f"conv_{uuid.uuid4().hex[:12]}"
            self._conversations[chat_id] = conv_id
            asyncio.create_task(self._register_conversation(conv_id, chat_id))
        return self._conversations[chat_id]

    async def _register_conversation(self, conv_id, chat_id):
        """Send agent_host_boot to register this conversation with the broker."""
        await self._send_json(
            {
                "type": "agent_host_boot",
                "protocolVersion": PROTOCOL_VERSION,
                "conversationId": conv_id,
                "project": self.project,
                "agentHostType": AGENT_HOST_TYPE,
                "capabilities": ["headless", "channel", "cost_tracking"],
                "claudeArgs": [],
                "startedAt": int(
                    datetime.now(timezone.utc).timestamp() * 1000
                ),
                "title": f"Hermes: {chat_id}",
            }
        )

        # Immediately ready (no boot sequence for Hermes)
        await self._send_json(
            {
                "type": "boot_event",
                "conversationId": conv_id,
                "step": "session_ready",
                "detail": "Hermes gateway connected",
                "t": int(datetime.now(timezone.utc).timestamp() * 1000),
            }
        )

    async def _receive_loop(self):
        """Listen for broker messages (user input, control verbs)."""
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                await self._handle_broker_message(msg)
        except websockets.ConnectionClosed:
            self._mark_disconnected()
        except asyncio.CancelledError:
            pass

    async def _handle_broker_message(self, msg):
        """Route broker messages to Hermes agent."""
        msg_type = msg.get("type")

        if msg_type == "input":
            conv_id = msg.get("conversationId")
            text = msg.get("input", "")
            chat_id = self._conv_to_chat(conv_id)

            if chat_id and text:
                # Emit user transcript entry
                await self._send_json(
                    {
                        "type": "transcript_entries",
                        "conversationId": conv_id,
                        "entries": [
                            {
                                "type": "user",
                                "uuid": str(uuid.uuid4()),
                                "timestamp": datetime.now(
                                    timezone.utc
                                ).isoformat(),
                                "message": {
                                    "role": "user",
                                    "content": text,
                                },
                            }
                        ],
                        "isInitial": False,
                    }
                )

                # Signal active
                await self._send_json(
                    {
                        "type": "conversation_status",
                        "conversationId": conv_id,
                        "status": "active",
                    }
                )

                # Route to Hermes agent via BasePlatformAdapter
                source = self.build_source(
                    chat_id=chat_id,
                    chat_name="Claudwerk User",
                    chat_type="dm",
                    user_id="jonas",
                    user_name="Jonas",
                )
                event = MessageEvent(
                    text=text,
                    message_type=MessageType.TEXT,
                    source=source,
                    message_id=str(uuid.uuid4()),
                )
                await self.handle_message(event)

        elif msg_type == "interrupt":
            pass  # TODO: interrupt current Hermes processing

        elif msg_type == "terminate_conversation":
            conv_id = msg.get("conversationId")
            chat_id = self._conv_to_chat(conv_id)
            if chat_id and chat_id in self._conversations:
                del self._conversations[chat_id]

    def _conv_to_chat(self, conv_id):
        """Reverse lookup: conversationId -> chat_id."""
        for chat_id, cid in self._conversations.items():
            if cid == conv_id:
                return chat_id
        return None

    async def _send_json(self, data):
        """Send JSON message over WebSocket."""
        if self.ws and self.ws.open:
            await self.ws.send(json.dumps(data))


# --- Plugin registration ---


def check_requirements() -> bool:
    return bool(
        os.getenv("CLAUDWERK_BROKER_URL")
        and os.getenv("CLAUDWERK_ADAPTER_SECRET")
    )


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    has_url = bool(
        os.getenv("CLAUDWERK_BROKER_URL") or extra.get("broker_url")
    )
    has_secret = bool(
        os.getenv("CLAUDWERK_ADAPTER_SECRET") or extra.get("secret")
    )
    return has_url and has_secret


def _env_enablement() -> dict | None:
    url = os.getenv("CLAUDWERK_BROKER_URL", "").strip()
    secret = os.getenv("CLAUDWERK_ADAPTER_SECRET", "").strip()
    if not url or not secret:
        return None
    seed = {"broker_url": url, "secret": secret}
    project = os.getenv("CLAUDWERK_DEFAULT_PROJECT", "").strip()
    if project:
        seed["project"] = project
    return seed


def register(ctx):
    ctx.register_platform(
        name="claudwerk",
        label="Claudwerk",
        adapter_factory=lambda cfg: ClaudwerkAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=[
            "CLAUDWERK_BROKER_URL",
            "CLAUDWERK_ADAPTER_SECRET",
        ],
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="CLAUDWERK_DEFAULT_PROJECT",
        max_message_length=100000,
        platform_hint=(
            "You are chatting via the Claudwerk control panel. "
            "You have access to Claudwerk MCP tools for spawning coding sessions, "
            "searching conversation history, managing the project board, and sending notifications. "
            "Use mcp_claudwerk_* tools when the user needs orchestration capabilities."
        ),
        emoji="",
    )
