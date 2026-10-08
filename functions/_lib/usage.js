// Daily usage limits (cost control) shared by chat.js, import-memory.js and usage.js.
//
// Plans:   guest (not logged in, counted per IP)  |  free (logged in)  |  pro (paid)
// Limits are per UTC day and configurable via Cloudflare env vars:
//   GUEST_DAILY_LIMIT (default 5), FREE_DAILY_LIMIT (default 15), PRO_DAILY_LIMIT (default 200),
//   IMPORT_DAILY_LIMIT (default 3 memory imports per user per day)
//
// Everything here FAILS OPEN: if the usage table / plan columns haven't been migrated yet
// (or D1 hiccups), chat keeps working rather than breaking. Run migrations/002_usage_limits.sql.

function intFromEnv(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function limitsFromEnv(env) {
  return {
    guest: intFromEnv(env.GUEST_DAILY_LIMIT, 5),
    free: intFromEnv(env.FREE_DAILY_LIMIT, 15),
    pro: intFromEnv(env.PRO_DAILY_LIMIT, 200),
    import: intFromEnv(env.IMPORT_DAILY_LIMIT, 3),
  };
}

export function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

// 'guest' | 'free' | 'pro'. A pro plan with a past plan_expires_at counts as free.
export async function getPlan(env, userId) {
  if (!userId) return 'guest';
  try {
    const row = await env.DB.prepare('SELECT plan, plan_expires_at FROM users WHERE id = ?')
      .bind(userId).first();
    if (!row) return 'free';
    if (row.plan === 'pro' && (row.plan_expires_at == null || row.plan_expires_at > Date.now())) {
      return 'pro';
    }
    return 'free';
  } catch (err) {
    return 'free'; // plan columns not migrated yet
  }
}

export function usageKeyFor(request, userId) {
  if (userId) return `u:${userId}`;
  return `ip:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
}

// Atomically adds `cost` to today's counter ONLY if it stays within `limit`.
// Returns { allowed, used, limit }.
export async function consume(env, key, cost, limit) {
  const day = utcDay();
  if (cost > limit) {
    return { allowed: false, used: await readUsed(env, key), limit };
  }
  const row = await env.DB.prepare(
    `INSERT INTO usage_counts (key, day, count) VALUES (?, ?, ?)
     ON CONFLICT(key, day) DO UPDATE SET count = count + ? WHERE count + ? <= ?
     RETURNING count`
  ).bind(key, day, cost, cost, cost, limit).first();

  if (row) return { allowed: true, used: row.count, limit };
  return { allowed: false, used: await readUsed(env, key), limit };
}

export async function readUsed(env, key) {
  try {
    const row = await env.DB.prepare('SELECT count FROM usage_counts WHERE key = ? AND day = ?')
      .bind(key, utcDay()).first();
    return row ? row.count : 0;
  } catch (err) {
    return 0;
  }
}

// Give back quota when the upstream AI call failed (so users aren't charged for errors).
export async function refund(env, key, cost) {
  try {
    await env.DB.prepare(
      'UPDATE usage_counts SET count = MAX(count - ?, 0) WHERE key = ? AND day = ?'
    ).bind(cost, key, utcDay()).run();
  } catch (err) {
    console.error('usage refund failed', err);
  }
}

// Housekeeping: drop counters older than 7 days. Called occasionally, not on every request.
export async function pruneOldUsage(env) {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await env.DB.prepare('DELETE FROM usage_counts WHERE day < ?').bind(cutoff).run();
  } catch (err) {
    console.error('usage prune failed', err);
  }
}

export function limitMessage(plan, limit) {
  if (plan === 'guest') {
    return `Guest limit reached (${limit} messages/day). Create a free account for more messages per day, or come back tomorrow (resets at 00:00 UTC).`;
  }
  if (plan === 'free') {
    return `Daily free limit reached (${limit} messages). Upgrade for a much higher limit, or come back tomorrow (resets at 00:00 UTC).`;
  }
  return `Daily fair-use limit reached (${limit} messages). It resets at 00:00 UTC.`;
}
