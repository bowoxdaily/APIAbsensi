const fs = require('fs/promises');
const path = require('path');
const { createRequestId, registerSession, getSession, finishSession } = require('../config/requestRegistry');
const { getSupabaseClient, getSupabaseConfig, hasSupabaseConfig } = require('../config/supabase');

const logsFilePath = path.join(process.cwd(), 'logs', 'data.txt');
const API_BASE_URL = process.env.FINGERSPOT_BASE_URL || 'https://developer.fingerspot.io/api';
const FINGERSPOT_API_TOKEN = process.env.FINGERSPOT_API_TOKEN || '';
const SYNC_RECHECK_TIMEOUT_MS = Math.max(Number(process.env.SYNC_RECHECK_TIMEOUT_MS || 15000), 1000);
const SYNC_RECHECK_POLL_MS = Math.max(Number(process.env.SYNC_RECHECK_POLL_MS || 1500), 250);
const SYNC_RECHECK_MAX_GAP = Math.max(Number(process.env.SYNC_RECHECK_MAX_GAP || 100), 1);

async function ensureLogFile() {
  await fs.mkdir(path.dirname(logsFilePath), { recursive: true });
  try {
    await fs.access(logsFilePath);
  } catch (error) {
    await fs.writeFile(logsFilePath, '', 'utf8');
  }
}

async function getWebhookRecords() {
  await ensureLogFile();
  const raw = await fs.readFile(logsFilePath, 'utf8');

  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

function extractUsersFromRecords(records, sourceCloudId) {
  const userEvents = records.filter((item) => {
    if (item?.body?.type !== 'get_userinfo') {
      return false;
    }

    if (sourceCloudId && item?.body?.cloud_id !== sourceCloudId) {
      return false;
    }

    return Boolean(item?.body?.data?.pin);
  });

  const latestByPin = new Map();
  for (const event of userEvents) {
    const pin = String(event.body.data.pin);
    latestByPin.set(pin, {
      pin,
      name: event.body.data.name || '',
      privilege: String(event.body.data.privilege || '0'),
      password: event.body.data.password || '',
      rfid: event.body.data.rfid || '',
      finger: String(event.body.data.finger || '0'),
      face: String(event.body.data.face || '0'),
      vein: String(event.body.data.vein || '0'),
      template: event.body.data.template || '',
      source_cloud_id: event.body.cloud_id || null,
      received_at: event.receivedAt || null,
    });
  }

  return Array.from(latestByPin.values()).sort((a, b) => comparePins(a.pin, b.pin));
}

function isNumericPin(pin) {
  return /^\d+$/.test(String(pin || ''));
}

function comparePins(leftPin, rightPin) {
  const left = String(leftPin);
  const right = String(rightPin);

  if (isNumericPin(left) && isNumericPin(right)) {
    return Number(left) - Number(right);
  }

  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
}

function buildMissingNumericPins(users) {
  if (!Array.isArray(users) || users.length < 2) {
    return [];
  }

  if (!users.every((user) => isNumericPin(user.pin))) {
    return [];
  }

  const pins = users.map((user) => Number(user.pin)).sort((a, b) => a - b);
  const missing = new Set();

  for (let index = 1; index < pins.length; index += 1) {
    const previousPin = pins[index - 1];
    const currentPin = pins[index];
    const gapSize = currentPin - previousPin - 1;

    if (gapSize <= 0 || gapSize > SYNC_RECHECK_MAX_GAP) {
      continue;
    }

    for (let pin = previousPin + 1; pin < currentPin; pin += 1) {
      missing.add(String(pin));
    }
  }

  return Array.from(missing);
}

function buildUserFromRecord(record) {
  return {
    pin: String(record.body.data.pin),
    name: record.body.data.name || '',
    privilege: String(record.body.data.privilege || '0'),
    password: record.body.data.password || '',
    rfid: record.body.data.rfid || '',
    finger: String(record.body.data.finger || '0'),
    face: String(record.body.data.face || '0'),
    vein: String(record.body.data.vein || '0'),
    template: record.body.data.template || '',
    source_cloud_id: record.body.cloud_id || null,
    received_at: record.receivedAt || null,
  };
}

async function requestSourceUserInfo(sourceCloudId, pin, transPrefix, index) {
  const response = await fetch(`${API_BASE_URL}/get_userinfo`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FINGERSPOT_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      trans_id: `${transPrefix}-recheck-${Date.now()}-${index + 1}`,
      cloud_id: sourceCloudId,
      pin,
    }),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = { raw: text };
  }

  return {
    status: response.status,
    ok: response.ok,
    data,
  };
}

async function waitForRecheckedPins(sourceCloudId, expectedPins, startedAtIso) {
  const expectedSet = new Set(expectedPins.map((pin) => String(pin)));
  const foundPins = new Map();
  const startedAtMs = new Date(startedAtIso).getTime();
  const deadline = Date.now() + SYNC_RECHECK_TIMEOUT_MS;

  while (Date.now() < deadline && foundPins.size < expectedSet.size) {
    const records = await getWebhookRecords();
    for (const record of records) {
      if (String(record?.body?.type || '').toLowerCase() !== 'get_userinfo') {
        continue;
      }

      if (String(record?.body?.cloud_id || '') !== String(sourceCloudId)) {
        continue;
      }

      const receivedAtMs = new Date(record.receivedAt || 0).getTime();
      if (!Number.isFinite(receivedAtMs) || receivedAtMs < startedAtMs) {
        continue;
      }

      const pin = String(record?.body?.data?.pin || '');
      if (!expectedSet.has(pin) || foundPins.has(pin)) {
        continue;
      }

      foundPins.set(pin, buildUserFromRecord(record));
    }

    if (foundPins.size < expectedSet.size) {
      await new Promise((resolve) => setTimeout(resolve, SYNC_RECHECK_POLL_MS));
    }
  }

  return Array.from(foundPins.values());
}

async function callSetUserInfo(payload) {
  const response = await fetch(`${API_BASE_URL}/set_userinfo`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FINGERSPOT_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = { raw: text };
  }

  return {
    status: response.status,
    ok: response.ok,
    data,
  };
}

function buildSyncConfig(input = {}) {
  return {
    sourceCloudId: input.source_cloud_id || input.sourceCloudId || null,
    targetCloudId: input.target_cloud_id || input.targetCloudId || null,
    transPrefix: input.trans_prefix || input.transPrefix || 'sync-user',
    startPin: input.start_pin ?? input.startPin ?? input.pin_start ?? input.pinStart ?? null,
    endPin: input.end_pin ?? input.endPin ?? input.pin_end ?? input.pinEnd ?? null,
    dryRun: Boolean(input.dry_run ?? input.dryRun),
    limit: Math.max(Number(input.limit || 1000), 1),
    concurrency: Math.min(Math.max(Number(input.concurrency || 3), 1), 10),
  };
}

function normalizePinBoundary(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  return trimmed;
}

function isPinWithinRange(pin, startPin, endPin) {
  const normalizedPin = String(pin);

  if (startPin !== null && comparePins(normalizedPin, startPin) < 0) {
    return false;
  }

  if (endPin !== null && comparePins(normalizedPin, endPin) > 0) {
    return false;
  }

  return true;
}

async function runEmployeeSync(rawConfig = {}) {
  const {
    sourceCloudId,
    targetCloudId,
    transPrefix,
    startPin,
    endPin,
    dryRun,
    limit,
    concurrency,
  } = buildSyncConfig(rawConfig);
  const requestId = rawConfig.request_id || rawConfig.requestId || createRequestId('sync');
  registerSession(requestId, { prefix: 'sync', type: 'sync-employees' });

  if (!FINGERSPOT_API_TOKEN) {
    return {
      statusCode: 500,
      payload: {
        success: false,
        message: 'FINGERSPOT_API_TOKEN belum diisi di .env',
      },
    };
  }

  if (!sourceCloudId) {
    return {
      statusCode: 400,
      payload: {
        success: false,
        message: 'source_cloud_id wajib diisi',
      },
    };
  }

  if (!targetCloudId) {
    return {
      statusCode: 400,
      payload: {
        success: false,
        message: 'target_cloud_id wajib diisi',
      },
    };
  }

  const records = await getWebhookRecords();
  const normalizedStartPin = normalizePinBoundary(startPin);
  const normalizedEndPin = normalizePinBoundary(endPin);
  const initialUsers = extractUsersFromRecords(records, sourceCloudId)
    .filter((user) => isPinWithinRange(user.pin, normalizedStartPin, normalizedEndPin))
    .slice(0, limit);
  const missingPins = buildMissingNumericPins(initialUsers);
  const recheckedPins = [];
  let users = initialUsers;

  if (missingPins.length) {
    const recheckStartedAt = new Date().toISOString();
    for (let i = 0; i < missingPins.length; i += 1) {
      const pin = missingPins[i];
      try {
        const upstream = await requestSourceUserInfo(sourceCloudId, pin, transPrefix, i);
        if (upstream.ok) {
          recheckedPins.push(pin);
        }
      } catch (error) {
        console.error(`[sync-userinfo] recheck pin ${pin} gagal: ${error.message}`);
      }
    }

    const recheckedUsers = await waitForRecheckedPins(sourceCloudId, missingPins, recheckStartedAt);
    if (recheckedUsers.length) {
      const mergedUsers = new Map(users.map((user) => [String(user.pin), user]));
      for (const user of recheckedUsers) {
        mergedUsers.set(String(user.pin), user);
      }
      users = Array.from(mergedUsers.values()).sort((a, b) => comparePins(a.pin, b.pin)).slice(0, limit);
    }
  }

  if (!users.length) {
    finishSession(requestId, { status: 'completed', cancelled: false, total: 0 });
    return {
      statusCode: 404,
      payload: {
        success: false,
        message: 'Tidak ada data userinfo dari mesin sumber. Jalankan get_userinfo dulu sampai webhook masuk.',
        count: 0,
        data: [],
        request_id: requestId,
      },
    };
  }

  if (dryRun) {
    finishSession(requestId, { status: 'completed', cancelled: false, total: users.length });
    return {
      statusCode: 200,
      payload: {
        success: true,
        message: 'Dry run OK. Tidak ada request yang dikirim ke Fingerspot.',
        count: users.length,
        target_cloud_id: targetCloudId,
        start_pin: normalizedStartPin,
        end_pin: normalizedEndPin,
        concurrency,
        request_id: requestId,
        data: users,
      },
    };
  }

  const results = [];
  let cancelled = false;
  async function processUser(user, index) {
    if (getSession(requestId)?.cancelled) {
      cancelled = true;
      return;
    }

    const payload = {
      type: 'set_userinfo',
      trans_id: `${transPrefix}-${Date.now()}-${index + 1}`,
      cloud_id: targetCloudId,
      data: {
        pin: user.pin,
        name: user.name,
        privilege: user.privilege,
        password: user.password,
        rfid: user.rfid,
        finger: user.finger,
        face: user.face,
        vein: user.vein,
        template: user.template,
      },
    };

    try {
      const upstream = await callSetUserInfo(payload);
      const rowSuccess = upstream.ok && upstream.data?.success !== false;
      results.push({
        pin: user.pin,
        success: rowSuccess,
        upstreamStatus: upstream.status,
        upstream: upstream.data,
      });
    } catch (error) {
      results.push({
        pin: user.pin,
        success: false,
        upstreamStatus: 0,
        upstream: { message: error.message },
      });
    }
  }

  for (let i = 0; i < users.length; i += 1) {
    if (getSession(requestId)?.cancelled) {
      cancelled = true;
      break;
    }

    await processUser(users[i], i);
  }

  const successCount = results.filter((item) => item.success).length;
  const hasFailure = successCount !== results.length;
  finishSession(requestId, {
    status: cancelled ? 'cancelled' : 'completed',
    cancelled,
    total: results.length,
    successCount,
    recheckedPins: recheckedPins.length,
  });

  return {
    statusCode: hasFailure ? 207 : 200,
    payload: {
      success: !hasFailure,
      message: hasFailure
        ? 'Sebagian user gagal dikirim ke mesin tujuan'
        : 'Semua user berhasil dikirim ke mesin tujuan',
      source_cloud_id: sourceCloudId,
      target_cloud_id: targetCloudId,
      start_pin: normalizedStartPin,
      end_pin: normalizedEndPin,
      request_id: requestId,
      total: results.length,
      success_count: successCount,
      failed_count: results.length - successCount,
      cancelled,
      rechecked_pins: recheckedPins,
      results,
    },
  };
}

async function getEmployees(req, res) {
  const sourceCloudId = req.query.source_cloud_id || req.query.cloud_id || null;
  const limit = Math.max(Number(req.query.limit || 500), 1);

  if (hasSupabaseConfig()) {
    const supabase = getSupabaseClient();
    const tableName = getSupabaseConfig().employeesTable;
    let query = supabase.from(tableName).select('*').order('received_at', { ascending: false }).limit(limit);

    if (sourceCloudId) {
      query = query.eq('source_cloud_id', sourceCloudId);
    }

    const { data, error } = await query;
    if (!error && Array.isArray(data)) {
      const users = data.map((item) => ({
        pin: item.pin || '',
        name: item.name || '',
        privilege: String(item.privilege || '0'),
        password: item.password || '',
        rfid: item.rfid || '',
        finger: String(item.finger || '0'),
        face: String(item.face || '0'),
        vein: String(item.vein || '0'),
        template: item.template || '',
        source_cloud_id: item.source_cloud_id || null,
        received_at: item.received_at || null,
      }));

      return res.json({
        success: true,
        source: 'supabase',
        count: users.length,
        data: users,
      });
    }
  }

  const records = await getWebhookRecords();
  const users = extractUsersFromRecords(records, sourceCloudId).slice(0, limit);

  return res.json({
    success: true,
    source: 'logs',
    count: users.length,
    data: users,
  });
}

async function syncEmployeesToMachine(req, res) {
  const syncResult = await runEmployeeSync(req.body || {});
  return res.status(syncResult.statusCode).json(syncResult.payload);
}

module.exports = {
  getEmployees,
  syncEmployeesToMachine,
  runEmployeeSync,
};
