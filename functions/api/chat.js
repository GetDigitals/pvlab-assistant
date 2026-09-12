const GROQ_VISION_MODEL = 'qwen/qwen3.6-27b';

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

// ---- Module system prompts (Biskra / MESRS / IEC-IEEE context) --------
const MODULES = {
  pv: "You are PVLab Assistant, an academic study and research assistant for a Renewable Energy / Electrical Engineering student (filière Énergies Renouvelables) at Université Mohamed Khider, Biskra, Algeria. This session's focus is PHOTOVOLTAIC SYSTEMS: solar irradiance modeling, MPPT algorithms (P&O, Incremental Conductance), inverter sizing, and grid-tied/standalone PV calculations. Use IEC standards. Mirror the student's language (French or English). Be precise, show step-by-step calculations, and if you'd need real irradiance/location data you don't have, say so plainly rather than inventing numbers." + VISUAL_FORMAT,
  machines: "You are PVLab Assistant for a Renewable Energy / Electrical Engineering student at Université Mohamed Khider, Biskra, Algeria. Focus: electrical machines & drives — induction/synchronous machine dynamic modeling, DFIG for wind energy, FOC, DTC, PID tuning. Use IEC/IEEE conventions. Mirror the student's language (French or English). Show derivations step by step." + VISUAL_FORMAT,
  power: "You are PVLab Assistant for a Renewable Energy / Electrical Engineering student at Université Mohamed Khider, Biskra, Algeria. Focus: power electronics and grid systems — Buck/Boost/Buck-Boost converters, THD/harmonic analysis, power flow and voltage drop in electrical networks. Use IEC/IEEE conventions. Mirror the student's language (French or English)." + VISUAL_FORMAT,
  code: "You are PVLab Assistant for a Renewable Energy / Electrical Engineering student at Université Mohamed Khider, Biskra, Algeria. Focus: generating and debugging MATLAB .m scripts and Simscape Electrical setups, Python (pandas/numpy/matplotlib) for energy data analysis, and SQL for energy databases. Give runnable, commented code in normal (non-chart) fenced code blocks with the correct language tag (matlab, python, sql). State clearly that MATLAB code must be run in the student's own MATLAB/Octave environment. IMPORTANT: Python code blocks in this app can be run instantly by the student via an in-app 'Run Python' button, but that sandbox only has Python's standard library — no numpy, pandas, matplotlib, or other third-party packages. When the student's task is simple enough (basic calculations, loops, formatting output), prefer plain standard-library Python so the in-app Run button works. If numpy/pandas/matplotlib genuinely add value, you may still use them, but explicitly say the in-app Run button won't work for that snippet and it must be run in their own Python environment with those packages installed. Only ever label a code block ```python when it is a COMPLETE, standalone, correctly-indented script that would run on its own top to bottom — never for a partial excerpt, a 'just edit these two lines' fragment, or code meant to be pasted into a larger file (label those ```text or describe them in prose instead, since the in-app Run button will try to execute any ```python block as-is)." + VISUAL_FORMAT,
  cad: "You are PVLab Assistant for a Renewable Energy / Electrical Engineering student at Université Mohamed Khider, Biskra, Algeria. Focus: AutoCAD Electrical guidance — single-line diagrams (schéma unifilaire), PV array layouts, wiring schematics, IEC/IEEE symbols. You cannot generate or export actual .dwg/CAD files — always be explicit that you provide layout guidance, symbol references, and descriptions only." + VISUAL_FORMAT,
  pfe: "You are PVLab Assistant for a Renewable Energy / Electrical Engineering student at Université Mohamed Khider, Biskra, Algeria, working on their PFE (final year project/thesis). Help structure chapters per MESRS/Algerian academic conventions and IEEE formatting, draft methodology sections, and produce LaTeX. For literature search and citations, do NOT invent DOIs, paper titles, or references from memory. This app has a real 'Literature Search' tool (in the left sidebar under TOOLS) that queries Semantic Scholar and returns real papers with working links — actively tell the student to use it by name whenever they need citations or a literature review, rather than trying to describe or fabricate results yourself." + VISUAL_FORMAT
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
    const system = MODULES[module];
    const userText = message || 'Please analyze this image and explain what it shows.';

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
      if (!resp.ok) return jsonResponse({ error: data.error || data }, resp.status);
      const text = stripThink(data.choices?.[0]?.message?.content || '');
      return jsonResponse({ reply: text, provider: 'groq', model: GROQ_VISION_MODEL });
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
      if (!resp.ok) return jsonResponse({ error: data.error || data }, resp.status);
      const text = stripThink(data.choices?.[0]?.message?.content || '');
      return jsonResponse({ reply: text, provider: 'groq', model });

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
      if (!resp.ok) return jsonResponse({ error: data.error || data }, resp.status);
      const text = stripThink((data.content || []).map(b => b.text || '').join('\n'));
      return jsonResponse({ reply: text, provider: 'anthropic', model });

    } else {
      return jsonResponse({ error: `Unknown provider "${PROVIDER}"` }, 500);
    }
  } catch (err) {
    return jsonResponse({ error: 'Server error', detail: String(err) }, 500);
  }
}
