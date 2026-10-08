import { getUserFromToken, jsonResponse } from "../_lib/auth.js";
import { limitsFromEnv, consume, refund } from "../_lib/usage.js";

const MAX_FACTS_PER_USER = 150;
const CHUNK_SIZE = 15000; // characters per AI extraction call
const MAX_CHUNKS_PER_IMPORT = 20; // cost control — caps how much of a huge export we process in one go
// D1 free plan allows only 50 queries per request. Budget for one import:
// auth 1 + usage 1-2 + existing-facts read 1 + inserts (<= MAX_NEW_FACTS) + trim 1.
const MAX_NEW_FACTS_PER_IMPORT = 30;

async function extractFactsWithAI(textChunk, env) {
  const prompt = `You will be given raw exported chat data from an AI assistant (ChatGPT or Gemini).
Extract ONLY durable, useful facts about the user: their subjects/field of study, preferences, ongoing projects, goals, working style.
Do NOT include one-off conversational details, questions asked, or the AI's own replies.
Return ONLY a JSON array like: [{"text": "...", "category": "subject|style|goal|general"}]
If nothing durable is found, return [].

DATA:
${textChunk}`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    }),
  });

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || "[]";

  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const norm = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");

// POST /api/import-memory  body: { exportData: <string or parsed JSON from ChatGPT/Gemini export> }
export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = await getUserFromToken(request, env);
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

  // Imports are the most expensive thing a user can trigger (up to 20 AI calls) — cap per day.
  const importKey = `imp:${userId}`;
  let importCharged = false;
  try {
    const importLimit = limitsFromEnv(env).import;
    const r = await consume(env, importKey, 1, importLimit);
    if (!r.allowed) {
      return jsonResponse({
        error: `Import limit reached (${importLimit} per day). Try again tomorrow (resets at 00:00 UTC).`,
        limit_reached: true,
      }, 429);
    }
    importCharged = true;
  } catch (err) {
    console.error("import limit check failed (failing open)", err);
  }

  try {
    const body = await request.json();
    const rawText =
      typeof body.exportData === "string" ? body.exportData : JSON.stringify(body.exportData || "");

    if (!rawText || rawText.length < 10) {
      if (importCharged) await refund(env, importKey, 1);
      return jsonResponse({ error: "exportData required" }, 400);
    }

    // Split the (often huge) export into manageable chunks
    const chunks = [];
    for (let i = 0; i < rawText.length; i += CHUNK_SIZE) {
      chunks.push(rawText.slice(i, i + CHUNK_SIZE));
    }
    const chunksToProcess = chunks.slice(0, MAX_CHUNKS_PER_IMPORT);

    let allFacts = [];
    for (const chunk of chunksToProcess) {
      const facts = await extractFactsWithAI(chunk, env);
      allFacts = allFacts.concat(facts);
    }

    // Dedupe in memory against what's already saved (1 query instead of 1 per fact).
    const { results: existingRows } = await env.DB.prepare(
      "SELECT fact_text FROM user_memory WHERE user_id = ?"
    ).bind(userId).all();
    const seen = new Set(existingRows.map((r) => norm(r.fact_text)));

    const now = Date.now();
    const toInsert = [];
    for (const fact of allFacts) {
      const text = String(fact.text || "").trim();
      const category = String(fact.category || "imported").trim();
      const key = norm(text);
      if (!text || seen.has(key)) continue;
      seen.add(key);
      toInsert.push({ text, category });
      if (toInsert.length >= MAX_NEW_FACTS_PER_IMPORT) break;
    }

    if (toInsert.length) {
      await env.DB.batch(
        toInsert.map((f) =>
          env.DB.prepare(
            "INSERT INTO user_memory (id, user_id, category, fact_text, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).bind(crypto.randomUUID(), userId, f.category, f.text, "import", now, now)
        )
      );
    }

    // Enforce the storage cap with a single statement.
    await env.DB.prepare(
      "DELETE FROM user_memory WHERE user_id = ? AND id NOT IN (SELECT id FROM user_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?)"
    ).bind(userId, userId, MAX_FACTS_PER_USER).run();

    const hitFactCap = toInsert.length >= MAX_NEW_FACTS_PER_IMPORT;
    const notes = [];
    if (chunks.length > MAX_CHUNKS_PER_IMPORT) {
      notes.push("File was larger than the per-import processing cap, so only the first portion was processed.");
    }
    if (hitFactCap) {
      notes.push(`Saved the first ${MAX_NEW_FACTS_PER_IMPORT} new facts; importing again later will add more.`);
    }

    return jsonResponse({
      success: true,
      chunksProcessed: chunksToProcess.length,
      totalChunksInFile: chunks.length,
      factsSaved: toInsert.length,
      note: notes.length ? notes.join(" ") : undefined,
    });
  } catch (err) {
    if (importCharged) await refund(env, importKey, 1);
    return jsonResponse({ error: "Import failed", detail: String(err) }, 500);
  }
}
