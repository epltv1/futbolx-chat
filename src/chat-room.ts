import { DurableObject } from "cloudflare:workers";
import type { Env, ChatMessage, RoomSettings } from "./types";

interface Session {
  ws: WebSocket;
  username: string | null;
  isOwner: boolean;
  isMod: boolean;
}

export class ChatRoom extends DurableObject<Env> {
  sessions: Map<WebSocket, Session> = new Map();
  messages: ChatMessage[] = [];
  settings: RoomSettings = {
    event_id: "",
    is_closed: false,
    slow_mode: 0,
    announcement: null,
    pinned_message_id: null,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Load state from storage when the DO wakes up
    this.ctx.blockConcurrencyWhile(async () => {
      const storedMessages = await this.ctx.storage.get<ChatMessage[]>("messages");
      const storedSettings = await this.ctx.storage.get<RoomSettings>("settings");

      if (storedMessages) this.messages = storedMessages;
      if (storedSettings) this.settings = storedSettings;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);

      // Temporary session until the client sends a "join" message
      this.sessions.set(server, {
        ws: server,
        username: null,
        isOwner: false,
        isMod: false,
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP fallback – get recent messages
    if (url.pathname.endsWith("/history")) {
      return Response.json({
        messages: this.messages.slice(-100),
        settings: this.settings,
      });
    }

    return new Response("Expected WebSocket", { status: 400 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
      const session = this.sessions.get(ws);
      if (!session) return;

      switch (data.type) {
        case "join":
          await this.handleJoin(ws, session, data);
          break;
        case "message":
          await this.handleMessage(ws, session, data);
          break;
        case "delete":
          await this.handleDelete(ws, session, data);
          break;
        case "pin":
          await this.handlePin(ws, session, data);
          break;
        case "unpin":
          await this.handleUnpin(ws, session);
          break;
        case "settings":
          await this.handleSettings(ws, session, data);
          break;
        case "clear":
          await this.handleClear(ws, session);
          break;
        default:
          this.send(ws, { type: "error", message: "Unknown action" });
      }
    } catch (err) {
      this.send(ws, { type: "error", message: "Invalid message" });
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
    this.broadcastPresence();
  }

  async webSocketError(ws: WebSocket) {
    this.sessions.delete(ws);
    this.broadcastPresence();
  }

  // ---------- Handlers ----------

  private async handleJoin(ws: WebSocket, session: Session, data: any) {
    const username = (data.username || "").trim();
    if (!username) {
      this.send(ws, { type: "error", message: "Username required" });
      return;
    }

    // Fetch profile from D1
    const profile = await this.env.DB.prepare(
      "SELECT * FROM profiles WHERE username = ?"
    )
      .bind(username)
      .first<{
        username: string;
        is_owner: number;
        is_mod: number;
        is_muted: number;
      }>();

    session.username = username;
    session.isOwner = !!profile?.is_owner;
    session.isMod = !!profile?.is_mod;

    // Send current state to the new user
    this.send(ws, {
      type: "init",
      messages: this.messages.slice(-100),
      settings: this.settings,
      profile: {
        username,
        is_owner: session.isOwner,
        is_mod: session.isMod,
        is_muted: !!profile?.is_muted,
      },
    });

    this.broadcastPresence();
  }

  private async handleMessage(ws: WebSocket, session: Session, data: any) {
    if (!session.username) {
      this.send(ws, { type: "error", message: "Not joined" });
      return;
    }

    // Check mute + closed
    const profile = await this.env.DB.prepare(
      "SELECT is_muted FROM profiles WHERE username = ?"
    )
      .bind(session.username)
      .first<{ is_muted: number }>();

    if (profile?.is_muted) {
      this.send(ws, { type: "error", message: "You are muted" });
      return;
    }

    if (this.settings.is_closed && !session.isOwner && !session.isMod) {
      this.send(ws, { type: "error", message: "Chat is closed" });
      return;
    }

    const text = (data.message || "").trim().slice(0, 250);
    if (!text) return;

    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      username: session.username,
      message: text,
      event_id: this.settings.event_id || "unknown",
      is_owner: session.isOwner,
      is_mod: session.isMod,
      reply_to_username: data.reply_to_username || null,
      reply_to_msg: data.reply_to_msg || null,
      reply_to_id: data.reply_to_id || null,
      created_at: new Date().toISOString(),
    };

    this.messages.push(msg);

    // Keep only last 500 messages in memory/storage
    if (this.messages.length > 500) {
      this.messages = this.messages.slice(-500);
    }

    await this.ctx.storage.put("messages", this.messages);

    this.broadcast({ type: "message", message: msg });
  }

  private async handleDelete(ws: WebSocket, session: Session, data: any) {
    if (!session.username) return;

    const id = data.id;
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return;

    // Owner, mod, or message author can delete
    if (!session.isOwner && !session.isMod && msg.username !== session.username) {
      this.send(ws, { type: "error", message: "Not allowed" });
      return;
    }

    this.messages = this.messages.filter((m) => m.id !== id);
    await this.ctx.storage.put("messages", this.messages);

    this.broadcast({ type: "delete", id });
  }

  private async handlePin(ws: WebSocket, session: Session, data: any) {
    if (!session.isOwner && !session.isMod) {
      this.send(ws, { type: "error", message: "Not allowed" });
      return;
    }

    this.settings.pinned_message_id = data.id || null;
    await this.ctx.storage.put("settings", this.settings);
    this.broadcast({ type: "settings", settings: this.settings });
  }

  private async handleUnpin(ws: WebSocket, session: Session) {
    if (!session.isOwner && !session.isMod) return;

    this.settings.pinned_message_id = null;
    await this.ctx.storage.put("settings", this.settings);
    this.broadcast({ type: "settings", settings: this.settings });
  }

  private async handleSettings(ws: WebSocket, session: Session, data: any) {
    if (!session.isOwner && !session.isMod) {
      this.send(ws, { type: "error", message: "Not allowed" });
      return;
    }

    if (typeof data.is_closed === "boolean") this.settings.is_closed = data.is_closed;
    if (typeof data.slow_mode === "number") this.settings.slow_mode = data.slow_mode;
    if (data.announcement !== undefined) this.settings.announcement = data.announcement;

    await this.ctx.storage.put("settings", this.settings);
    this.broadcast({ type: "settings", settings: this.settings });
  }

  private async handleClear(ws: WebSocket, session: Session) {
    if (!session.isOwner && !session.isMod) return;

    this.messages = [];
    await this.ctx.storage.put("messages", this.messages);
    this.broadcast({ type: "clear" });
  }

  // ---------- Helpers ----------

  private send(ws: WebSocket, data: any) {
    try {
      ws.send(JSON.stringify(data));
    } catch {}
  }

  private broadcast(data: any) {
    const payload = JSON.stringify(data);
    for (const [ws] of this.sessions) {
      try {
        ws.send(payload);
      } catch {}
    }
  }

  private broadcastPresence() {
    const online = [...this.sessions.values()]
      .filter((s) => s.username)
      .map((s) => s.username);

    this.broadcast({
      type: "presence",
      count: online.length,
      users: online,
    });
  }
}
