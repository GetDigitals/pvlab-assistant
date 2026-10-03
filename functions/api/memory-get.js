import { getUserFromToken, jsonResponse } from "../_lib/auth.js";

// GET /api/memory-get -> returns the raw list, for a "your memory" settings screen
export async function onRequestGet(context) {
  const { request, env } = context;
  const userId = await getUserFromToken(request, env);
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

  const { results } = await env.DB.prepare(
    "SELECT id, category, fact_text, source, updated_at FROM user_memory WHERE user_id = ? ORDER BY updated_at DESC"
  )
    .bind(userId)
    .all();

  return jsonResponse({ memory: results });
}

// Import this from chat.js to build the system-prompt context block.
// Usage in chat.js:
//   import { getMemoryContextString } from "./memory-get.js";
//   const memoryBlock = await getMemoryContextString(userId, env);
//   const systemPrompt = BASE_SYSTEM_PROMPT + "\n\n" + memoryBlock;
export async function getMemoryContextString(userId, env) {
  if (!userId) return "";

  const { results } = await env.DB.prepare(
    "SELECT fact_text FROM user_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT 40"
  )
    .bind(userId)
    .all();

  if (!results.length) return "";

  return (
    "User context (remembered facts about this student — use naturally, don't list them back):\n" +
    results.map((r) => `- ${r.fact_text}`).join("\n")
  );
}
