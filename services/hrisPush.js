/**
 * Push attlog ke webhook HRIS/Laravel secara realtime (outbound).
 * Dedup via source_key agar tidak double kirim (webhook + cron).
 */

const fs = require('fs/promises');
const path = require('path');
const { getMachineMap } = require('../config/runtimeConfig');
const { buildSourceKey } = require('../utils/sourceKey');

const deliveredKeysPath = path.join(process.cwd(), 'logs', 'hris-delivered-keys.json');
const failedLogPath = path.join(process.cwd(), 'logs', 'hris-push-failed.txt');
const MAX_LOG_FILE_BYTES = Math.max(Number(process.env.MAX_LOG_FILE_BYTES || 10 * 1024 * 1024), 1024 * 1024);

const HRIS_WEBHOOK_URL = (process.env.HRIS_WEBHOOK_URL || '').trim();
const HRIS_WEBHOOK_TOKEN = process.env.HRIS_WEBHOOK_TOKEN || '';
const HRIS_PUSH_RETRY_MAX = Math.max(Number(process.env.HRIS_PUSH_RETRY_MAX || 3), 1);
const HRIS_PUSH_RETRY_DELAY_MS = Math.max(Number(process.env.HRIS_PUSH_RETRY_DELAY_MS || 1000), 200);
const HRIS_PUSH_TIMEOUT_MS = Math.max(Number(process.env.HRIS_PUSH_TIMEOUT_MS || 8000), 2000);
const HRIS_DELIVERED_KEYS_MAX = Math.max(Number(process.env.HRIS_DELIVERED_KEYS_MAX || 10000), 1000);
const HRIS_PUSH_FROM_CRON =
  String(process.env.HRIS_PUSH_FROM_CRON || 'true').toLowerCase() === 'true';

let deliveredKeysCache = null;
let deliveredKeysWriteQueue = Promise.resolve();

function isHrisPushEnabled() {
  return (
    String(process.env.ENABLE_HRIS_PUSH || 'false').toLowerCase() === 'true' &&
    Boolean(HRIS_WEBHOOK_URL)
  );
}

function isHrisPushFromCronEnabled() {
  return isHrisPushEnabled() && HRIS_PUSH_FROM_CRON;
}

function resolveMachineName(cloudId) {
  const map = getMachineMap();
  return map[String(cloudId)] || null;
}

/** Kunci dedup push HRIS — sama dengan source_key Supabase. */
function buildDeliveryKey(attlogRow) {
  if (attlogRow?.source_key && !String(attlogRow.source_key).startsWith('webhook|')) {
    return attlogRow.source_key;
  }

  const cloudId = attlogRow.cloud_id || attlogRow.cloudId || '';
  return buildSourceKey(cloudId, attlogRow);
}

function buildHrisPayload(attlogRow) {
  const cloudId = attlogRow.cloud_id || attlogRow.cloudId || null;
  const scanTime = attlogRow.scan_date || attlogRow.scan || null;

  return {
    event: 'attlog',
    source_key: buildDeliveryKey(attlogRow),
    cloud_id: cloudId,
    machine_name: attlogRow.machine_name || resolveMachineName(cloudId),
    pin: String(attlogRow.pin),
    scan: scanTime,
    datetime: scanTime,
    scan_date: scanTime,
    verify: attlogRow.verify ?? null,
    status_scan: attlogRow.status_scan ?? null,
    photo_url: attlogRow.photo_url || null,
    received_at: attlogRow.fetched_at || new Date().toISOString(),
  };
}

function isHrisResponseSuccess(result) {
  if (!result.ok) {
    return false;
  }

  const body = result.body;
  if (!body || typeof body !== 'object') {
    return true;
  }

  if (body.success === false) {
    return false;
  }

  const data = body.data;
  if (data && typeof data === 'object') {
    const failed = Number(data.failed || 0);
    const processed = Number(data.processed || 0);
    if (failed > 0 && processed === 0) {
      return false;
    }
    if (Array.isArray(data.results)) {
      const hasFailure = data.results.some((item) => item?.status === 'failed');
      if (hasFailure && processed === 0) {
        return false;
      }
    }
  }

  return true;
}

function extractHrisError(result) {
  const body = result.body;
  if (!body || typeof body !== 'object') {
    return `HTTP ${result.status}`;
  }

  const firstResult = body.data?.results?.[0];
  return firstResult?.message || body.message || `HTTP ${result.status}`;
}

/**
 * Cek apakah error adalah non-recoverable business rule error dari HRIS.
 * Jika true, jangan retry — langsung fail dan catat.
 */
function isNonRecoverableHrisError(errorMessage) {
  if (!errorMessage || typeof errorMessage !== 'string') {
    return false;
  }

  const lowerError = errorMessage.toLowerCase();

  // Business rule errors dari HRIS (non-recoverable, tidak perlu retry)
  const nonRecoverablePatterns = [
    'scan during work hours', // Scan di luar jam kerja
    'before', // e.g. "before 16:30"
    'weekend', // e.g. "< 6 hours on weekend"
    'duplicate scan', // Scan duplikat
    'invalid pin', // PIN tidak valid
    'employee not found', // Karyawan tidak terdaftar
  ];

  return nonRecoverablePatterns.some((pattern) => lowerError.includes(pattern));
}

function buildAuthHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (HRIS_WEBHOOK_TOKEN) {
    headers['X-Fingerspot-Token'] = HRIS_WEBHOOK_TOKEN;
  }

  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDeliveredKeysFile() {
  await fs.mkdir(path.dirname(deliveredKeysPath), { recursive: true });
  try {
    await fs.access(deliveredKeysPath);
  } catch {
    await fs.writeFile(deliveredKeysPath, JSON.stringify({ keys: [] }, null, 2), 'utf8');
  }
}

async function loadDeliveredKeys() {
  if (deliveredKeysCache) {
    return deliveredKeysCache;
  }

  await ensureDeliveredKeysFile();
  try {
    const raw = await fs.readFile(deliveredKeysPath, 'utf8');
    const parsed = raw ? JSON.parse(raw) : { keys: [] };
    deliveredKeysCache = new Set(Array.isArray(parsed.keys) ? parsed.keys : []);
  } catch {
    deliveredKeysCache = new Set();
  }

  return deliveredKeysCache;
}

function queuePersistDeliveredKeys() {
  deliveredKeysWriteQueue = deliveredKeysWriteQueue
    .then(async () => {
      if (!deliveredKeysCache) {
        return;
      }

      const keys = Array.from(deliveredKeysCache);
      const trimmed =
        keys.length > HRIS_DELIVERED_KEYS_MAX
          ? keys.slice(keys.length - HRIS_DELIVERED_KEYS_MAX)
          : keys;

      if (trimmed.length !== keys.length) {
        deliveredKeysCache = new Set(trimmed);
      }

      await fs.writeFile(
        deliveredKeysPath,
        JSON.stringify({ keys: trimmed, updatedAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    })
    .catch((error) => {
      console.error(`[hris-push] gagal simpan dedup keys: ${error.message}`);
    });

  return deliveredKeysWriteQueue;
}

async function markDelivered(sourceKey) {
  const keys = await loadDeliveredKeys();
  keys.add(sourceKey);
  await queuePersistDeliveredKeys();
}

async function wasDelivered(sourceKey) {
  const keys = await loadDeliveredKeys();
  return keys.has(sourceKey);
}

async function appendFailedLog(entry) {
  await fs.mkdir(path.dirname(failedLogPath), { recursive: true });

  try {
    const stat = await fs.stat(failedLogPath);
    if (stat.size > MAX_LOG_FILE_BYTES) {
      const raw = await fs.readFile(failedLogPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const trimmedLines = lines.slice(Math.floor(lines.length / 2));
      await fs.writeFile(
        failedLogPath,
        trimmedLines.join('\n') + (trimmedLines.length ? '\n' : ''),
        'utf8'
      );
    }
  } catch (error) {
    // Best effort trim: gagal trim tidak boleh memblokir append log.
  }

  await fs.appendFile(failedLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function postToHris(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HRIS_PUSH_TIMEOUT_MS);

  try {
    const response = await fetch(HRIS_WEBHOOK_URL, {
      method: 'POST',
      headers: buildAuthHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text || null;
    }

    return {
      ok: response.ok,
      status: response.status,
      body: parsed,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function pushAttlogToHris(attlogRow, options = {}) {
  if (!isHrisPushEnabled()) {
    return { skipped: true, reason: 'disabled' };
  }

  const deliveryKey = buildDeliveryKey(attlogRow);
  if (!deliveryKey || !attlogRow?.pin || !attlogRow?.scan_date) {
    return { skipped: true, reason: 'incomplete_row' };
  }

  const force = options.force === true;
  if (!force && (await wasDelivered(deliveryKey))) {
    return { skipped: true, reason: 'already_delivered' };
  }

  const payload = buildHrisPayload(attlogRow);
  let lastError = null;

  for (let attempt = 1; attempt <= HRIS_PUSH_RETRY_MAX; attempt += 1) {
    try {
      const result = await postToHris(payload);

      if (isHrisResponseSuccess(result)) {
        await markDelivered(deliveryKey);
        console.log(
          `[hris-push] OK pin=${payload.pin} cloud=${payload.cloud_id} scan=${payload.scan} status=${result.status}`
        );
        return { success: true, status: result.status, payload };
      }

      lastError = extractHrisError(result);
      
      // Jika error adalah business rule non-recoverable, jangan retry
      if (isNonRecoverableHrisError(lastError)) {
        console.warn(
          `[hris-push] gagal attempt ${attempt}/${HRIS_PUSH_RETRY_MAX} pin=${payload.pin} — ${lastError} (non-recoverable, stop retry)`
        );
        break;
      }

      console.warn(
        `[hris-push] gagal attempt ${attempt}/${HRIS_PUSH_RETRY_MAX} pin=${payload.pin} — ${lastError}`
      );
    } catch (error) {
      lastError = error.name === 'AbortError' ? 'timeout' : error.message;
      console.warn(
        `[hris-push] error attempt ${attempt}/${HRIS_PUSH_RETRY_MAX} pin=${payload.pin} — ${lastError}`
      );
    }

    if (attempt < HRIS_PUSH_RETRY_MAX) {
      await sleep(HRIS_PUSH_RETRY_DELAY_MS * attempt);
    }
  }

  await appendFailedLog({
    failedAt: new Date().toISOString(),
    source_key: deliveryKey,
    payload,
    error: lastError,
  });

  return { success: false, error: lastError, payload };
}

async function pushAttlogsToHris(rows, options = {}) {
  if (!rows?.length) {
    return { pushed: 0, skipped: 0, failed: 0 };
  }

  const enabled = options.fromCron ? isHrisPushFromCronEnabled() : isHrisPushEnabled();
  if (!enabled) {
    return { pushed: 0, skipped: rows.length, failed: 0 };
  }

  let pushed = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const result = await pushAttlogToHris(row, options);
    if (result.skipped) {
      skipped += 1;
    } else if (result.success) {
      pushed += 1;
    } else {
      failed += 1;
    }
  }

  if (pushed || failed) {
    console.log(`[hris-push] batch selesai: pushed=${pushed} skipped=${skipped} failed=${failed}`);
  }

  return { pushed, skipped, failed };
}

function logHrisPushStartup() {
  if (String(process.env.ENABLE_HRIS_PUSH || 'false').toLowerCase() !== 'true') {
    return;
  }

  if (!HRIS_WEBHOOK_URL) {
    console.warn('[hris-push] ENABLE_HRIS_PUSH=true tapi HRIS_WEBHOOK_URL kosong — push dinonaktifkan');
    return;
  }

  console.log(`[hris-push] Aktif → ${HRIS_WEBHOOK_URL} (cron push: ${HRIS_PUSH_FROM_CRON})`);
}

module.exports = {
  isHrisPushEnabled,
  isHrisPushFromCronEnabled,
  buildHrisPayload,
  pushAttlogToHris,
  pushAttlogsToHris,
  logHrisPushStartup,
  isNonRecoverableHrisError,
};
