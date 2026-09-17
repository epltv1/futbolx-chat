import { ChatRoom } from "./chat-room";
import type { Env } from "./types";

export { ChatRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS for browser
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // ---------- Profile registration (HTTP) ----------
    if (url.pathname === "/register" && request.method === "POST") {
      try {
        const body = await request.json() as { username: string; ip?: string };
        let username = (body.username || "").trim();

        if (!username || username.length > 20) {
          return json({ error: "Invalid username" }, 400);
        }

        // Normalize Futbolx
        const isFutbolx = username.toLowerCase() === "futbolx";
        if (isFutbolx) username = "Futbolx";

        // IP limit (max 3 accounts per IP) – skip for Futbolx
        if (!isFutbolx && body.ip) {
          const count = await env.DB.prepare(
            "SELECT COUNT(*) as c FROM profiles WHERE device_ip = ?"
          )
            .bind(body.ip)
            .first<{ c: number }>();

          if (count && count.c >= 3) {
            return json({ error: "Limit reached: 3 accounts per IP." }, 400);
          }
        }

        // Check if username already exists
        const existing = await env.DB.prepare(
          "SELECT username FROM profiles WHERE username = ?"
        )
          .bind(username)
          .first();

        if (existing) {
          return json({ error: "Username taken or unavailable." }, 400);
        }

        await env.DB.prepare(
          `INSERT INTO profiles (username, device_ip, is_owner, is_mod, is_muted)
           VALUES (?, ?, ?, 0, 0)`
        )
          .bind(username, body.ip || null, isFutbolx ? 1 : 0)
          .run();

        return json({
          success: true,
          username,
          is_owner: isFutbolx,
          is_mod: false,
          is_muted: false,
        });
      } catch (err) {
        return json({ error: "Registration failed" }, 500);
      }
    }

    // ---------- Get profile ----------
    if (url.pathname === "/profile" && request.method === "GET") {
      const username = url.searchParams.get("username");
      if (!username) return json({ error: "Missing username" }, 400);

      const profile = await env.DB.prepare(
        "SELECT username, is_owner, is_mod, is_muted FROM profiles WHERE username = ?"
      )
        .bind(username)
        .first();

      if (!profile) return json({ error: "Not found" }, 404);
      return json(profile);
    }

    // ---------- Admin actions on profiles ----------
    if (url.pathname === "/admin/profile" && request.method === "POST") {
      const body = await request.json() as {
        actor: string;
        target: string;
        action: "mute" | "unmute" | "mod" | "unmod";
      };

      // Verify actor is owner or mod
      const actor = await env.DB.prepare(
        "SELECT is_owner, is_mod FROM profiles WHERE username = ?"
      )
        .bind(body.actor)
        .first<{ is_owner: number; is_mod: number }>();

      if (!actor || (!actor.is_owner && !actor.is_mod)) {
        return json({ error: "Not allowed" }, 403);
      }

      if (body.action === "mute" || body.action === "unmute") {
        await env.DB.prepare(
          "UPDATE profiles SET is_muted = ? WHERE username = ?"
        )
          .bind(body.action === "mute" ? 1 : 0, body.target)
          .run();
      }

      if ((body.action === "mod" || body.action === "unmod") && actor.is_owner) {
        await env.DB.prepare(
          "UPDATE profiles SET is_mod = ? WHERE username = ?"
        )
          .bind(body.action === "mod" ? 1 : 0, body.target)
          .run();
      }

      return json({ success: true });
    }

    // ---------- List members (for admin dashboard) ----------
    if (url.pathname === "/admin/members" && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT username, device_ip, is_owner, is_mod, is_muted FROM profiles ORDER BY username"
      ).all();

      return json(rows.results || []);
    }

    // ---------- Route to Durable Object (chat room) ----------
    // Expected path: /room/:eventId  or  /room/:eventId/history
    const match = url.pathname.match(/^\/room\/([^/]+)(\/.*)?$/);
    if (match) {
      const eventId = decodeURIComponent(match[1]);
      const id = env.CHAT_ROOM.idFromName(eventId);
      const stub = env.CHAT_ROOM.get(id);

      // Make sure the DO knows its event_id
      // (we pass it via a header or just let the client send it)
      return stub.fetch(request);
    }

    return new Response("FutbolX Chat Worker is running", {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  },
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
