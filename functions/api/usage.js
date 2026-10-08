import { getUserFromToken, jsonResponse } from '../_lib/auth.js';
import { getPlan, limitsFromEnv, usageKeyFor, readUsed } from '../_lib/usage.js';

// GET /api/usage -> { enabled, plan, used, limit, signedIn }
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return jsonResponse({ enabled: false });

  try {
    const userId = await getUserFromToken(request, env);
    const plan = await getPlan(env, userId);
    const limit = limitsFromEnv(env)[plan];
    const used = await readUsed(env, usageKeyFor(request, userId));
    return jsonResponse({ enabled: true, plan, used: Math.min(used, limit), limit, signedIn: !!userId });
  } catch (err) {
    return jsonResponse({ enabled: false });
  }
}
