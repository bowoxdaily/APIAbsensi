const fs = require('fs/promises');
const path = require('path');
const { getMachineMap } = require('../config/runtimeConfig');
const { getSupabaseClient, getSupabaseConfig, hasSupabaseConfig } = require('../config/supabase');

const logsFilePath = path.join(process.cwd(), 'logs', 'data.txt');
const attlogFilePath = path.join(process.cwd(), 'logs', 'attlog.txt');
const userinfoFilePath = path.join(process.cwd(), 'logs', 'userinfo.txt');
const otherFilePath = path.join(process.cwd(), 'logs', 'other.txt');
const syncStateFilePath = path.join(process.cwd(), 'logs', 'sync-state.json');
const API_TOKEN = process.env.API_TOKEN || '';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';

async function ensureLogFile() {
  await fs.mkdir(path.dirname(logsFilePath), { recursive: true });
  try {
    await fs.access(logsFilePath);
  } catch (error) {
    await fs.writeFile(logsFilePath, '', 'utf8');
  }
}

async function ensureNamedLogFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch (error) {
    await fs.writeFile(filePath, '', 'utf8');
  }
}

async function appendJsonLine(filePath, payload) {
  await ensureNamedLogFile(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function resolveWebhookLogFilePath(body = {}) {
  const type = String(body?.type || '').toLowerCase();

  if (type === 'attlog') {
    return attlogFilePath;
  }

  if (type === 'get_userinfo' || type === 'set_userinfo' || type === 'userinfo') {
    return userinfoFilePath;
  }

  return otherFilePath;
}

async function ensureSyncStateFile() {
  await fs.mkdir(path.dirname(syncStateFilePath), { recursive: true });
  try {
    await fs.access(syncStateFilePath);
  } catch (error) {
    await fs.writeFile(syncStateFilePath, JSON.stringify({ machines: {} }, null, 2), 'utf8');
  }
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    null
  );
}

function isAuthorized(req) {
  if (!API_TOKEN) {
    return true;
  }

  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const headerToken = req.headers['x-api-token'];

  return bearerToken === API_TOKEN || headerToken === API_TOKEN;
}

function isWebhookAuthorized(req) {
  if (!WEBHOOK_TOKEN) {
    return true;
  }

  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const headerToken = req.headers['x-webhook-token'];
  const queryToken = req.query.webhook_token;

  return bearerToken === WEBHOOK_TOKEN || headerToken === WEBHOOK_TOKEN || queryToken === WEBHOOK_TOKEN;
}

function normalizeMachineId(req) {
  return (
    req.body?.machine_id ||
    req.body?.machineId ||
    req.body?.device_id ||
    req.body?.deviceId ||
    req.body?.cloud_id ||
    req.body?.cloudId ||
    req.body?.cloudid ||
    req.headers['x-machine-id'] ||
    req.query.machine_id ||
    req.query.machineId ||
    'unknown'
  );
}

function resolveMachineName(machineId) {
  const machineMap = getMachineMap();

  return machineMap[machineId] || null;
}

function getRawEventId(req, payload) {
  return (
    req.body?.id ||
    req.body?.event_id ||
    req.body?.eventId ||
    req.body?.sn ||
    req.body?.serial ||
    payload.id
  );
}

function buildAttlogRow(payload) {
  const data = payload?.body?.data || {};
  const cloudId = payload?.machineId || payload?.body?.cloud_id || payload?.body?.cloudId || null;

  if (String(payload?.body?.type || '').toLowerCase() !== 'attlog') {
    return null;
  }

  if (!cloudId || !data.pin || !(data.scan || data.scan_date)) {
    return null;
  }

  return {
    source_key: `webhook|${payload.id}`,
    cloud_id: String(cloudId),
    trans_id: payload?.body?.trans_id || null,
    pin: String(data.pin),
    scan_date: data.scan || data.scan_date,
    verify: typeof data.verify === 'number' ? data.verify : null,
    status_scan: typeof data.status_scan === 'number' ? data.status_scan : null,
    photo_url: data.photo_url || null,
    raw_payload: payload.body || null,
    fetched_at: payload.receivedAt || new Date().toISOString(),
  };
}

function buildEmployeeRow(payload) {
  const type = String(payload?.body?.type || '').toLowerCase();
  const data = payload?.body?.data || {};
  const cloudId = payload?.machineId || payload?.body?.cloud_id || payload?.body?.cloudId || null;

  if (type !== 'get_userinfo') {
    return null;
  }

  if (!cloudId || !data.pin) {
    return null;
  }

  return {
    source_key: `${String(cloudId)}|${String(data.pin)}`,
    source_cloud_id: String(cloudId),
    pin: String(data.pin),
    name: data.name || '',
    privilege: String(data.privilege || '0'),
    password: data.password || '',
    rfid: data.rfid || '',
    finger: String(data.finger || '0'),
    face: String(data.face || '0'),
    vein: String(data.vein || '0'),
    template: data.template || '',
    raw_payload: payload.body || null,
    received_at: payload.receivedAt || new Date().toISOString(),
  };
}

async function persistWebhookToSupabase(payload) {
  if (!hasSupabaseConfig()) {
    return;
  }

  const supabase = getSupabaseClient();
  const config = getSupabaseConfig();
  const attlogRow = buildAttlogRow(payload);
  const employeeRow = buildEmployeeRow(payload);

  if (attlogRow) {
    const { error } = await supabase.from(config.table).upsert(attlogRow, { onConflict: 'source_key' });
    if (error) {
      console.error(`[webhook-db] gagal simpan attlog: ${error.message}`);
    }
  }

  if (employeeRow) {
    const { error } = await supabase.from(config.employeesTable).upsert(employeeRow, { onConflict: 'source_key' });
    if (error) {
      console.error(`[webhook-db] gagal simpan employee: ${error.message}`);
    }
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function storeWebhook(req, res) {
  if (!isWebhookAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized webhook',
    });
  }

  const machineId = normalizeMachineId(req);
  const payload = {
    id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    eventId: getRawEventId(req, { id: null }),
    machineId,
    machineName: resolveMachineName(machineId),
    receivedAt: new Date().toISOString(),
    ip: getClientIp(req),
    method: req.method,
    path: req.originalUrl,
    headers: {
      'user-agent': req.headers['user-agent'] || null,
      'content-type': req.headers['content-type'] || null,
      'x-api-token': req.headers['x-api-token'] ? '[redacted]' : null,
      'x-webhook-token': req.headers['x-webhook-token'] ? '[redacted]' : null,
    },
    body: req.body,
  };

  await ensureLogFile();
  await fs.appendFile(logsFilePath, `${JSON.stringify(payload)}\n`, 'utf8');
  await appendJsonLine(resolveWebhookLogFilePath(req.body), payload);
  await persistWebhookToSupabase(payload);

  return res.status(201).json({
    success: true,
    message: 'Webhook berhasil disimpan',
    data: payload,
  });
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

async function getWebhookLogs(req, res) {
  const machineId = req.query.machine_id || req.query.machineId;
  const limit = Math.max(Number(req.query.limit || 20), 1);
  const records = await getWebhookRecords();
  const items = records
    .filter((item) => (machineId ? item.machineId === machineId : true))
    .slice(-limit)
    .reverse();

  return res.json({
    success: true,
    count: items.length,
    data: items,
  });
}

async function getWebhookLogById(req, res) {
  const { id } = req.params;
  const records = await getWebhookRecords();
  const found = records.find((item) => item && item.id === id);

  if (!found) {
    return res.status(404).json({
      success: false,
      message: 'Webhook tidak ditemukan',
    });
  }

  return res.json({
    success: true,
    data: found,
  });
}

async function getSyncFeed(req, res) {
  const machineId = req.query.machine_id || req.query.machineId;
  const since = req.query.since || req.query.after || null;
  const limit = Math.max(Number(req.query.limit || 100), 1);
  const records = await getWebhookRecords();

  const items = records.filter((item) => {
    if (machineId && item.machineId === machineId) {
      return false;
    }

    if (!since) {
      return true;
    }

    return item.receivedAt > since || item.id > since;
  });

  return res.json({
    success: true,
    count: Math.min(items.length, limit),
    data: items.slice(-limit),
    cursor: items.length ? items[items.length - 1].receivedAt : since,
  });
}

async function markMachineSynced(req, res) {
  const machineId = normalizeMachineId(req);
  const cursor = req.body?.cursor || req.body?.since || req.body?.last_sync || null;

  await ensureSyncStateFile();
  const state = await readJsonFile(syncStateFilePath, { machines: {} });

  state.machines[machineId] = {
    cursor,
    updatedAt: new Date().toISOString(),
  };

  await writeJsonFile(syncStateFilePath, state);

  return res.json({
    success: true,
    message: 'Status sinkron mesin disimpan',
    data: {
      machineId,
      cursor,
    },
  });
}

async function getSyncState(req, res) {
  await ensureSyncStateFile();
  const state = await readJsonFile(syncStateFilePath, { machines: {} });

  return res.json({
    success: true,
    data: state,
  });
}

async function healthCheck(req, res) {
  return res.json({
    success: true,
    message: 'OK',
  });
}

module.exports = {
  storeWebhook,
  getWebhookLogs,
  getWebhookLogById,
  getSyncFeed,
  markMachineSynced,
  getSyncState,
  healthCheck,
};
