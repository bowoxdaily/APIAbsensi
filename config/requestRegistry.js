const sessions = new Map();

function createRequestId(prefix = 'req') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function registerSession(requestId, meta = {}) {
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
  return sessions.get(requestId) || null;
}

function cancelSession(requestId) {
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
  return Boolean(sessions.get(requestId)?.cancelled);
}

function finishSession(requestId, patch = {}) {
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
