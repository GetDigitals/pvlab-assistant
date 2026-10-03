import { hashPassword, createSessionToken, jsonResponse } from "../_lib/auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { email, password } = await request.json();

    if (!email || !password || password.length < 6) {
      return jsonResponse({ error: "Valid email and password (6+ chars) required" }, 400);
    }

    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind(email.toLowerCase())
      .first();
    if (existing) {
      return jsonResponse({ error: "Account already exists" }, 409);
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const now = Date.now();

    await env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(id, email.toLowerCase(), passwordHash, now)
      .run();

    const token = await createSessionToken(id, env);

    return jsonResponse({ token, userId: id });
  } catch (err) {
    return jsonResponse({ error: "Signup failed", detail: String(err) }, 500);
  }
}
