const fs = require('fs/promises');
const path = require('path');
const { getMachineMap } = require('../config/runtimeConfig');
const { getSupabaseClient, getSupabaseConfig, hasSupabaseConfig } = require('../config/supabase');
const { pushAttlogToHris } = require('../services/hrisPush');
const { buildSourceKey } = require('../utils/sourceKey');
const { ensureFile, appendJsonLineWithRotate, readRecentJsonLines } = require('../utils/logIO');

const logsFilePath = path.join(process.cwd(), 'logs', 'data.txt');
const attlogFilePath = path.join(process.cwd(), 'logs', 'attlog.txt');
const otherFilePath = path.join(process.cwd(), 'logs', 'other.txt');
const syncStateFilePath = path.join(process.cwd(), 'logs', 'sync-state.json');
const MAX_LOG_FILE_BYTES = Math.max(Number(process.env.MAX_LOG_FILE_BYTES || 10 * 1024 * 1024), 1024 * 1024);
const LOG_TAIL_MAX_BYTES = Math.max(Number(process.env.LOG_TAIL_MAX_BYTES || 4 * 1024 * 1024), 64 * 1024);
const LOG_TAIL_MAX_LINES = Math.max(Number(process.env.LOG_TAIL_MAX_LINES || 10000), 100);
const API_TOKEN = process.env.API_TOKEN || '';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';
const ENABLE_USERINFO_WEBHOOK_LOG =
  String(process.env.ENABLE_USERINFO_WEBHOOK_LOG || 'false').toLowerCase() === 'true';

async function ensureLogFile() {
  await ensureFile(logsFilePath);
}

async function ensureNamedLogFile(filePath) {
  await ensureFile(filePath);
}

async function appendJsonLine(filePath, payload) {
  await ensureNamedLogFile(filePath);
  await appendJsonLineWithRotate(filePath, payload, { maxBytes: MAX_LOG_FILE_BYTES });
}

const SKIP_WEBHOOK_TYPES = ENABLE_USERINFO_WEBHOOK_LOG
  ? new Set()
  : new Set(['get_userinfo', 'set_userinfo', 'userinfo']);

function resolveWebhookLogFilePath(body = {}) {
  const type = String(body?.type || '').toLowerCase();

  if (type === 'attlog') {
    return attlogFilePath;
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
    source_key: buildSourceKey(String(cloudId), {
      pin: data.pin,
      scan_date: data.scan || data.scan_date,
      verify: typeof data.verify === 'number' ? data.verify : null,
      status_scan: typeof data.status_scan === 'number' ? data.status_scan : null,
    }),
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



async function persistWebhookToSupabase(payload) {
  if (!hasSupabaseConfig()) {
    return;
  }

  const supabase = getSupabaseClient();
  const config = getSupabaseConfig();
  const attlogRow = buildAttlogRow(payload);

  if (attlogRow) {
    const { error } = await supabase.from(config.table).upsert(attlogRow, { onConflict: 'source_key' });
    if (error) {
      console.error(`[webhook-db] gagal simpan attlog: ${error.message}`);
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

  // Skip event userinfo — tidak perlu diproses, hemat resource server
  const incomingType = String(req.body?.type || '').toLowerCase();
  if (SKIP_WEBHOOK_TYPES.has(incomingType)) {
    return res.status(200).json({
      success: true,
      message: 'Event diabaikan (set ENABLE_USERINFO_WEBHOOK_LOG=true untuk menyimpan userinfo)',
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
  await appendJsonLine(logsFilePath, payload);
  await appendJsonLine(resolveWebhookLogFilePath(req.body), payload);
  await persistWebhookToSupabase(payload);

  const attlogRow = buildAttlogRow(payload);
  if (attlogRow) {
    attlogRow.machine_name = payload.machineName;
    pushAttlogToHris(attlogRow).catch((error) => {
      console.error(`[hris-push] webhook background error: ${error.message}`);
    });
  }

  return res.status(201).json({
    success: true,
    message: 'Webhook berhasil disimpan',
    data: payload,
  });
}

async function getWebhookRecords() {
  await ensureLogFile();
  return readRecentJsonLines(logsFilePath, {
    maxBytes: LOG_TAIL_MAX_BYTES,
    maxLines: LOG_TAIL_MAX_LINES,
  });
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
