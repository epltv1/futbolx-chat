export interface Env {
  CHAT_ROOM: DurableObjectNamespace;
  DB: D1Database;
}

export interface ChatMessage {
  id: string;
  username: string;
  message: string;
  event_id: string;
  is_owner: boolean;
  is_mod: boolean;
  reply_to_username?: string | null;
  reply_to_msg?: string | null;
  reply_to_id?: string | null;
  created_at: string;
}

export interface RoomSettings {
  event_id: string;
  is_closed: boolean;
  slow_mode: number;
  announcement: string | null;
  pinned_message_id: string | null;
}

export interface Profile {
  username: string;
  device_ip: string | null;
  is_owner: boolean;
  is_mod: boolean;
  is_muted: boolean;
}
