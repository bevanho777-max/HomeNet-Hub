// http_push collector (§3) — receive machine-initiated POSTs.
// These targets are NOT polled. The POST /api/push/:targetId route validates
// the X-Push-Token header against the target's token_env, then hands the body
// here for normalization. We also track staleness: if no push arrives within
// a grace window the target is reported offline by the scheduler's sweep.

const PUSH_GRACE_MS = Number(process.env.PUSH_GRACE_MS || 20000);

const lastPush = new Map(); // targetId -> ts(ms)

export function markPush(targetId) {
  lastPush.set(targetId, Date.now());
}

export function isPushStale(targetId) {
  const t = lastPush.get(targetId);
  if (!t) return true;
  return Date.now() - t > PUSH_GRACE_MS;
}

// Validate the shared-secret header for a push target.
export function checkPushToken(target, headerToken, env) {
  const envName = target.source?.token_env;
  if (!envName) return { ok: false, reason: 'target has no token_env' };
  const expected = env[envName];
  if (!expected) return { ok: false, reason: `env ${envName} not set` };
  if (!headerToken || headerToken !== expected) return { ok: false, reason: 'bad token' };
  return { ok: true };
}
