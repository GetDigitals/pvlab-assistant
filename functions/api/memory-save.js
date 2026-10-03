import { getUserFromToken, jsonResponse } from "../_lib/auth.js";

const MAX_FACTS_PER_USER = 150; // hard cap to keep storage + system-prompt size small

async function trimToCap(userId, env) {
  const { results: countRows } = await env.DB.prepare(
    "SELECT id FROM user_memory WHERE user_id = ? ORDER BY updated_at DESC"
  )
    .bind(userId)
    .all();

  if (countRows.length > MAX_FACTS_PER_USER) {
    const toDelete = countRows.slice(MAX_FACTS_PER_USER).map((r) => r.id);
    for (const id of toDelete) {
      await env.DB.prepare("DELETE FROM user_memory WHERE id = ?").bind(id).run();
    }
  }
}

// POST /api/memory-save  body: { facts: [{text, category}], source: "chat" }
export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = await getUserFromToken(request, env);
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

  try {
    const { facts, source = "chat" } = await request.json();
    if (!Array.isArray(facts) || facts.length === 0) {
      return jsonResponse({ error: "facts array required" }, 400);
    }

    const now = Date.now();
    let savedCount = 0;

    for (const fact of facts) {
      const text = String(fact.text || "").trim();
      const category = String(fact.category || "general").trim();
      if (!text) continue;

      // de-dupe: skip exact repeats
      const existing = await env.DB.prepare(
        "SELECT id FROM user_memory WHERE user_id = ? AND fact_text = ?"
      )
        .bind(userId, text)
        .first();
      if (existing) continue;

      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO user_memory (id, user_id, category, fact_text, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, userId, category, text, source, now, now)
        .run();
      savedCount++;
    }

    await trimToCap(userId, env);

    return jsonResponse({ success: true, savedCount });
  } catch (err) {
    return jsonResponse({ error: "Memory save failed", detail: String(err) }, 500);
  }
}
