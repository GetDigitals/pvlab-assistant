import { getUserFromToken, jsonResponse } from '../_lib/auth.js';

// GET /api/chat-history?module=pv -> { history: [{role, content}, ...] }
export async function onRequestGet(context) {
  const { request, env } = context;
  const userId = await getUserFromToken(request, env);
  if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const module = url.searchParams.get('module') || 'pv';

  const { results } = await env.DB.prepare(
    'SELECT role, content FROM chat_history WHERE user_id = ? AND module = ? ORDER BY created_at ASC LIMIT 200'
  ).bind(userId, module).all();

  return jsonResponse({ history: results });
}

// DELETE /api/chat-history?module=pv -> clears that module's saved history for this user
export async function onRequestDelete(context) {
  const { request, env } = context;
  const userId = await getUserFromToken(request, env);
  if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const module = url.searchParams.get('module') || 'pv';

  await env.DB.prepare('DELETE FROM chat_history WHERE user_id = ? AND module = ?')
    .bind(userId, module).run();

  return jsonResponse({ success: true });
}
