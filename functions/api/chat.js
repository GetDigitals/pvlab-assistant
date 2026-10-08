import { getUserFromToken } from '../_lib/auth.js';
import { getMemoryContextString } from './memory-get.js';
import { getPlan, limitsFromEnv, usageKeyFor, consume, refund, pruneOldUsage, limitMessage } from '../_lib/usage.js';

const GROQ_VISION_MODEL = 'qwen/qwen3.6-27b';

// Pulls 1-2 durable facts out of a single exchange and stores them (fire-and-forget).
// Only runs every 3rd exchange to keep Groq usage and D1 writes low.
async function maybeExtractMemory({ env, userId, userText, replyText, historyLength }) {
  if (!userId) return;
  if (historyLength % 6 !== 0) return; // history has [user,assistant] pairs; every 3rd exchange

  try {
    const groqKey = env.GROQ_API_KEY;
    if (!groqKey) return;

    const extractPrompt = `From this exchange, extract at most 1-2 durable facts about the student (subject focus, preference, ongoing project/thesis topic, working style). Return ONLY a JSON array like [{"text":"...","category":"subject|style|goal|general"}]. If nothing durable, return [].
User: ${userText}
Assistant: ${replyText}`;

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: env.GROQ_MODEL || 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: extractPrompt }],
        max_tokens: 300,
        temperature: 0.2
      })
    });
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content || '[]';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const facts = JSON.parse(cleaned);
    if (!Array.isArray(facts) || facts.length === 0) return;

    const now = Date.now();
    for (const fact of facts) {
      const text = String(fact.text || '').trim();
      const category = String(fact.category || 'general').trim();
      if (!text) continue;
      const existing = await env.DB.prepare(
        'SELECT id FROM user_memory WHERE user_id = ? AND fact_text = ?'
      ).bind(userId, text).first();
      if (existing) continue;
      const id = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO user_memory (id, user_id, category, fact_text, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, userId, category, text, 'chat', now, now).run();
    }

    // trim to storage cap (single statement — D1 free plan allows only 50 queries per request)
    await env.DB.prepare(
      'DELETE FROM user_memory WHERE user_id = ? AND id NOT IN (SELECT id FROM user_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT 150)'
    ).bind(userId, userId).run();
  } catch (err) {
    // memory extraction failing should never break the chat response
    console.error('memory extraction failed', err);
  }
}

// Saves one exchange (user + assistant message) to chat_history for cross-device sync.
// Trims each user+module thread to the most recent 200 messages to keep storage bounded.
async function saveChatTurn({ env, userId, module, userText, replyText }) {
  if (!userId) return;
  try {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO chat_history (id, user_id, role, content, module, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), userId, 'user', userText, module, now),
      env.DB.prepare(
        'INSERT INTO chat_history (id, user_id, role, content, module, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), userId, 'assistant', replyText, module, now + 1)
    ]);

    await env.DB.prepare(
      'DELETE FROM chat_history WHERE user_id = ? AND module = ? AND id NOT IN (SELECT id FROM chat_history WHERE user_id = ? AND module = ? ORDER BY created_at DESC LIMIT 200)'
    ).bind(userId, module, userId, module).run();
  } catch (err) {
    console.error('chat history save failed', err);
  }
}

// ---- Shared instructions for charts / diagrams / tables ----------------
const VISUAL_FORMAT = `

When a chart, diagram, or table would genuinely help the answer, use these exact formats (the frontend renders them automatically):
- Line/bar chart: a fenced code block labeled "chart" containing ONLY valid JSON like:
  \`\`\`chart
  {"type":"line","title":"Efficiency vs Irradiance","labels":["200","400","600","800","1000"],"datasets":[{"label":"Efficiency (%)","data":[12,15,17,18,18.5]}]}
  \`\`\`
  "type" can be "line" or "bar". Only include this when you have real or clearly-stated example numbers — never fabricate data and present it as measured.
- Flowchart / block diagram / state machine: a fenced code block labeled "mermaid" containing valid Mermaid syntax. Keep it simple and safe: use "flowchart TD" or "graph TD", short plain-ASCII node labels in quotes (no Greek letters, no subscripts, no special symbols — write "alpha-beta" not "α-β", "Id_ref" not "I_d,ref"), and simple arrows like A --> B. Example:
  \`\`\`mermaid
  flowchart TD
    A["Speed Reference"] --> B["PI Controller"]
    B --> C["Park Transform"]
    C --> D["Inverter"]
  \`\`\`
- Comparison/parameter tables: standard markdown pipe tables.
Do not overuse these — only when they add real clarity over prose. Never use them for AutoCAD/.dwg content (that stays as guidance text).`;

// ---- Module system prompts (generic — personalized via memory, not hardcoded) --------
// IMPORTANT: these prompts are intentionally NOT tied to any one university/country.
// If a logged-in student has told the assistant (in any past chat) which university,
// country, or academic conventions they follow, that comes in automatically via
// memoryBlock (see getMemoryContextString) and the model should use it. For guests or
// students who haven't mentioned it, the assistant asks naturally rather than assuming
// a specific place — this tool is used across multiple countries, not just one.
const BASE_IDENTITY = "You are PVLab Assistant, an academic study and research assistant for Renewable Energy / Electrical Engineering students (filière Énergies Renouvelables / Electrical Engineering). Do not assume the student is at any specific university or country unless they've told you (directly in this chat, or via remembered context) — if it's not established and it matters for the answer (e.g. local academic formatting conventions, grid codes, curriculum structure), ask briefly rather than assuming. Mirror the student's language (French, English, or Arabic — whichever they write in).";
const MODULES = {
  pv: BASE_IDENTITY + " This session's focus is PHOTOVOLTAIC SYSTEMS: solar irradiance modeling, MPPT algorithms (P&O, Incremental Conductance), inverter sizing, and grid-tied/standalone PV calculations. Use IEC standards by default (ask if the student's country uses a different grid code/standard). Be precise, show step-by-step calculations. If the student needs real irradiance/peak-sun-hours data for a location, do NOT invent numbers — tell them the 'Quick Calculators' tool (PV Sizing tab, in the left sidebar under TOOLS) has a '📡 Real data' button that pulls real PVGIS satellite irradiance data for any latitude/longitude they enter." + VISUAL_FORMAT,
  machines: BASE_IDENTITY + " Focus: electrical machines & drives — induction/synchronous machine dynamic modeling, DFIG for wind energy, FOC, DTC, PID tuning. Use IEC/IEEE conventions by default. Show derivations step by step." + VISUAL_FORMAT,
  power: BASE_IDENTITY + " Focus: power electronics and grid systems — Buck/Boost/Buck-Boost converters, THD/harmonic analysis, power flow and voltage drop in electrical networks. Use IEC/IEEE conventions by default." + VISUAL_FORMAT,
  code: BASE_IDENTITY + " Focus: generating and debugging MATLAB .m scripts and Simscape Electrical setups, Python (pandas/numpy/matplotlib) for energy data analysis, and SQL for energy databases. Give runnable, commented code in normal (non-chart) fenced code blocks with the correct language tag (matlab, python, sql). State clearly that MATLAB code must be run in the student's own MATLAB/Octave environment. IMPORTANT: Python code blocks in this app can be run instantly by the student via an in-app 'Run Python' button, but that sandbox only has Python's standard library — no numpy, pandas, matplotlib, or other third-party packages. When the student's task is simple enough (basic calculations, loops, formatting output), prefer plain standard-library Python so the in-app Run button works. If numpy/pandas/matplotlib genuinely add value, you may still use them, but explicitly say the in-app Run button won't work for that snippet and it must be run in their own Python environment with those packages installed. Only ever label a code block ```python when it is a COMPLETE, standalone, correctly-indented script that would run on its own top to bottom — never for a partial excerpt, a 'just edit these two lines' fragment, or code meant to be pasted into a larger file (label those ```text or describe them in prose instead, since the in-app Run button will try to execute any ```python block as-is)." + VISUAL_FORMAT,
  cad: BASE_IDENTITY + " Focus: AutoCAD Electrical guidance — single-line diagrams (schéma unifilaire), PV array layouts, wiring schematics, IEC/IEEE symbols. You cannot generate or export actual .dwg/CAD files — always be explicit that you provide layout guidance, symbol references, and descriptions only." + VISUAL_FORMAT,
  pfe: BASE_IDENTITY + " This session is for the student's final year project/thesis (PFE / capstone / dissertation — terminology varies by country). Help structure chapters, draft methodology sections, and produce LaTeX. Formatting conventions differ by country and institution (e.g. MESRS guidelines in Algeria, other national bodies elsewhere) — if the student hasn't said which conventions apply, ask once rather than assuming; once they tell you (or it's in remembered context), follow IEEE formatting as the technical baseline plus whatever local convention applies. For literature search and citations, do NOT invent DOIs, paper titles, or references from memory. This app has a real 'Literature Search' tool (in the left sidebar under TOOLS) that queries Semantic Scholar and returns real papers with working links — actively tell the student to use it by name whenever they need citations or a literature review, rather than trying to describe or fabricate results yourself." + VISUAL_FORMAT
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function stripThink(text) {
  if (!text) return '';
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const idx = cleaned.search(/<think>/i);
  if (idx !== -1) {
    cleaned = cleaned.slice(0, idx);
  }
  cleaned = cleaned.trim();
  return cleaned || 'The response got cut off while the model was still thinking — please try again, or ask a shorter/simpler question.';
}

export async function onRequestPost(context) {
  try {
    const accessCode = context.env.ACCESS_CODE;
    if (accessCode) {
      const provided = context.request.headers.get('X-PVLab-Access') || '';
      if (provided !== accessCode) {
        return jsonResponse({ error: 'Invalid or missing access code' }, 401);
      }
    }

    const { module = 'pv', message, history = [], image } = await context.request.json();

    if ((!message || typeof message !== 'string') && !image) {
      return jsonResponse({ error: 'message is required' }, 400);
    }
    if (!MODULES[module]) {
      return jsonResponse({ error: `unknown module: ${module}` }, 400);
    }

    const PROVIDER = context.env.PROVIDER || 'groq';
    const userText = message || 'Please analyze this image and explain what it shows.';

    // Memory is optional: only kicks in if DB is bound AND the user sent a valid session token.
    // Guest/logged-out users still work exactly as before.
    let userId = null;
    let memoryBlock = '';
    if (context.env.DB) {
      try {
        userId = await getUserFromToken(context.request, context.env);
        if (userId) memoryBlock = await getMemoryContextString(userId, context.env);
      } catch (err) {
        console.error('memory lookup failed', err);
      }
    }
    const system = MODULES[module] + (memoryBlock ? '\n\n' + memoryBlock : '');

    // ---- Daily usage limit (cost control). Fails open if the usage table isn't migrated yet. ----
    let usageInfo = null;
    let usageKey = null;
    const usageCost = image ? 2 : 1; // vision requests cost more, so they count double
    if (context.env.DB) {
      try {
        const plan = await getPlan(context.env, userId);
        const limit = limitsFromEnv(context.env)[plan];
        usageKey = usageKeyFor(context.request, userId);
        const r = await consume(context.env, usageKey, usageCost, limit);
        usageInfo = { plan, used: r.used, limit };
        if (!r.allowed) {
          return jsonResponse({
            error: limitMessage(plan, limit),
            limit_reached: true,
            usage: { plan, used: Math.min(r.used, limit), limit }
          }, 429);
        }
        if (Math.random() < 0.02) context.waitUntil(pruneOldUsage(context.env));
      } catch (err) {
        console.error('usage check failed (failing open)', err);
        usageKey = null;
      }
    }
    const refundUsage = () => (usageKey ? refund(context.env, usageKey, usageCost) : null);

    // ---- Image analysis path (Groq vision model, no chat history reuse) ----
    if (image) {
      if (PROVIDER !== 'groq') {
        return jsonResponse({ error: 'Image analysis is only available with the Groq provider in this prototype.' }, 400);
      }
      const groqKey = context.env.GROQ_API_KEY;
      if (!groqKey) return jsonResponse({ error: 'Missing GROQ_API_KEY environment variable' }, 500);

      const body = {
        model: GROQ_VISION_MODEL,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              { type: 'image_url', image_url: { url: image } }
            ]
          }
        ],
        max_tokens: 900
      };
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (!resp.ok) { await refundUsage(); return jsonResponse({ error: data.error || data }, resp.status); }
      const text = stripThink(data.choices?.[0]?.message?.content || '');
      return jsonResponse({ reply: text, provider: 'groq', model: GROQ_VISION_MODEL, usage: usageInfo });
    }

    // ---- Normal text path -----------------------------------------------
    if (PROVIDER === 'groq') {
      const groqKey = context.env.GROQ_API_KEY;
      const model = context.env.GROQ_MODEL || 'openai/gpt-oss-120b';
      if (!groqKey) return jsonResponse({ error: 'Missing GROQ_API_KEY environment variable' }, 500);

      const body = {
        model,
        messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: userText }],
        max_tokens: 1200
      };
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (!resp.ok) { await refundUsage(); return jsonResponse({ error: data.error || data }, resp.status); }
      const text = stripThink(data.choices?.[0]?.message?.content || '');

      if (userId) {
        context.waitUntil(saveChatTurn({ env: context.env, userId, module, userText, replyText: text }));
        context.waitUntil(maybeExtractMemory({
          env: context.env, userId, userText, replyText: text, historyLength: history.length
        }));
      }

      return jsonResponse({ reply: text, provider: 'groq', model, usage: usageInfo });

    } else if (PROVIDER === 'anthropic') {
      const anthropicKey = context.env.ANTHROPIC_API_KEY;
      const model = context.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
      if (!anthropicKey) return jsonResponse({ error: 'Missing ANTHROPIC_API_KEY environment variable' }, 500);

      const body = {
        model,
        max_tokens: 1200,
        system,
        messages: [...history.map(h => ({ role: h.role, content: h.content })), { role: 'user', content: userText }]
      };
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (!resp.ok) { await refundUsage(); return jsonResponse({ error: data.error || data }, resp.status); }
      const text = stripThink((data.content || []).map(b => b.text || '').join('\n'));

      if (userId) {
        context.waitUntil(saveChatTurn({ env: context.env, userId, module, userText, replyText: text }));
      }

      return jsonResponse({ reply: text, provider: 'anthropic', model, usage: usageInfo });

    } else {
      return jsonResponse({ error: `Unknown provider "${PROVIDER}"` }, 500);
    }
  } catch (err) {
    return jsonResponse({ error: 'Server error', detail: String(err) }, 500);
  }
}
