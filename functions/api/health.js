export async function onRequestGet(context) {
  const PROVIDER = context.env.PROVIDER || 'groq';
  const model = PROVIDER === 'groq'
    ? (context.env.GROQ_MODEL || 'openai/gpt-oss-120b')
    : (context.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6');
  return new Response(JSON.stringify({ ok: true, provider: PROVIDER, model }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
