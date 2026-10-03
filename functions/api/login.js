import { verifyPassword, createSessionToken, jsonResponse } from "../_lib/auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { email, password } = await request.json();
    if (!email || !password) {
      return jsonResponse({ error: "Email and password required" }, 400);
    }

    const user = await env.DB.prepare("SELECT id, password_hash FROM users WHERE email = ?")
      .bind(email.toLowerCase())
      .first();

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return jsonResponse({ error: "Invalid email or password" }, 401);
    }

    const token = await createSessionToken(user.id, env);
    return jsonResponse({ token, userId: user.id });
  } catch (err) {
    return jsonResponse({ error: "Login failed", detail: String(err) }, 500);
  }
}
