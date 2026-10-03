import { getUserFromToken, jsonResponse } from "../_lib/auth.js";

const MAX_FACTS_PER_USER = 150;
const CHUNK_SIZE = 15000; // characters per AI extraction call
const MAX_CHUNKS_PER_IMPORT = 20; // cost control — caps how much of a huge export we process in one go

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

// POST /api/import-memory  body: { exportData: <string or parsed JSON from ChatGPT/Gemini export> }
export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = await getUserFromToken(request, env);
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

  try {
    const body = await request.json();
    const rawText =
      typeof body.exportData === "string" ? body.exportData : JSON.stringify(body.exportData || "");

    if (!rawText || rawText.length < 10) {
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

    const now = Date.now();
    let savedCount = 0;

    for (const fact of allFacts) {
      const text = String(fact.text || "").trim();
      const category = String(fact.category || "imported").trim();
      if (!text) continue;

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
        .bind(id, userId, category, text, "import", now, now)
        .run();
      savedCount++;
    }

    await trimToCap(userId, env);

    return jsonResponse({
      success: true,
      chunksProcessed: chunksToProcess.length,
      totalChunksInFile: chunks.length,
      factsSaved: savedCount,
      note:
        chunks.length > MAX_CHUNKS_PER_IMPORT
          ? "File was larger than the per-import processing cap; only the first portion was processed. User can re-run import to continue (dedupe will skip what's already saved)."
          : undefined,
    });
  } catch (err) {
    return jsonResponse({ error: "Import failed", detail: String(err) }, 500);
  }
}
