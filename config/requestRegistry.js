const sessions = new Map();

const SESSION_REGISTRY_TTL_MS = Math.max(
  Number(process.env.SESSION_REGISTRY_TTL_MS || 24 * 60 * 60 * 1000),
  60 * 1000
);
const SESSION_REGISTRY_MAX = Math.max(Number(process.env.SESSION_REGISTRY_MAX || 5000), 100);

function toTimestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function cleanupExpiredSessions(now = Date.now()) {
  for (const [id, session] of sessions.entries()) {
    const lastUpdatedAt = toTimestamp(session?.updatedAt || session?.createdAt);
    if (!lastUpdatedAt || now - lastUpdatedAt > SESSION_REGISTRY_TTL_MS) {
      sessions.delete(id);
    }
  }

  if (sessions.size <= SESSION_REGISTRY_MAX) {
    return;
  }

  const ordered = Array.from(sessions.values()).sort((left, right) => {
    const leftTime = toTimestamp(left?.updatedAt || left?.createdAt);
    const rightTime = toTimestamp(right?.updatedAt || right?.createdAt);
    return leftTime - rightTime;
  });

  const overflowCount = sessions.size - SESSION_REGISTRY_MAX;
  for (let index = 0; index < overflowCount; index += 1) {
    sessions.delete(ordered[index].id);
  }
}

function createRequestId(prefix = 'req') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function registerSession(requestId, meta = {}) {
  cleanupExpiredSessions();
  const id = requestId || createRequestId(meta.prefix || 'req');
  sessions.set(id, {
    id,
    cancelled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...meta,
  });

  return sessions.get(id);
}

function getSession(requestId) {
  cleanupExpiredSessions();
  return sessions.get(requestId) || null;
}

function cancelSession(requestId) {
  cleanupExpiredSessions();
  const session = sessions.get(requestId);
  if (!session) {
    return null;
  }

  session.cancelled = true;
  session.updatedAt = new Date().toISOString();
  sessions.set(requestId, session);
  return session;
}

function isCancelled(requestId) {
  cleanupExpiredSessions();
  return Boolean(sessions.get(requestId)?.cancelled);
}

function finishSession(requestId, patch = {}) {
  cleanupExpiredSessions();
  const session = sessions.get(requestId);
  if (!session) {
    return null;
  }

  const nextSession = {
    ...session,
    ...patch,
    finishedAt: new Date().toISOString(),
  };

  sessions.set(requestId, nextSession);
  return nextSession;
}

module.exports = {
  createRequestId,
  registerSession,
  getSession,
  cancelSession,
  isCancelled,
  finishSession,
};
