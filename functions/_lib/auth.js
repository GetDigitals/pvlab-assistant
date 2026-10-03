// Shared auth helpers for Cloudflare Pages Functions.
// Files under functions/_lib/ are NOT auto-routed by Cloudflare Pages
// (underscore-prefixed folders are excluded from routing), so this is
// safe to import from other functions/api/*.js files.

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `${toHex(salt)}:${toHex(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  const salt = fromHex(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(bits) === hashHex;
}

export async function createSessionToken(userId, env) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000; // 30 days
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(token, userId, now, expiresAt)
    .run();
  return token;
}

export async function getUserFromToken(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;

  const session = await env.DB.prepare(
    "SELECT user_id, expires_at FROM sessions WHERE token = ?"
  )
    .bind(token)
    .first();

  if (!session || session.expires_at < Date.now()) return null;
  return session.user_id;
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
