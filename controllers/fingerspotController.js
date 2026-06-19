const API_BASE_URL = process.env.FINGERSPOT_BASE_URL || 'https://developer.fingerspot.io/api';
const FINGERSPOT_API_TOKEN = process.env.FINGERSPOT_API_TOKEN || '';

function getFingerspotToken(cloudId, customToken) {
  if (customToken) return customToken;
  
  if (process.env.FINGERSPOT_API_TOKENS_JSON) {
    try {
      const tokensMap = JSON.parse(process.env.FINGERSPOT_API_TOKENS_JSON);
      if (cloudId && tokensMap[cloudId]) {
        return tokensMap[cloudId];
      }
    } catch (e) {
      console.error('Gagal parsing FINGERSPOT_API_TOKENS_JSON:', e.message);
    }
  }
  
  return FINGERSPOT_API_TOKEN;
}
const MAX_BULK_DAYS = 60;
const USERINFO_BULK_DEFAULT_CONCURRENCY = Math.min(
  Math.max(Number(process.env.USERINFO_BULK_DEFAULT_CONCURRENCY || 5), 1),
  20
);
const USERINFO_BULK_BATCH_DELAY_MS = Math.max(Number(process.env.USERINFO_BULK_BATCH_DELAY_MS || 100), 0);
const USERINFO_BULK_MAX_PINS = Math.max(Number(process.env.USERINFO_BULK_MAX_PINS || 1000), 1);
const USERINFO_REQUEST_TIMEOUT_MS = Math.max(Number(process.env.USERINFO_REQUEST_TIMEOUT_MS || 10000), 1000);
const USERINFO_BULK_INCLUDE_RESULTS_DEFAULT =
  String(process.env.USERINFO_BULK_INCLUDE_RESULTS_DEFAULT || 'false').toLowerCase() === 'true';
const USERINFO_BULK_MAX_RESULT_ITEMS = Math.max(
  Number(process.env.USERINFO_BULK_MAX_RESULT_ITEMS || 300),
  10
);

const { getSupabaseClient, getSupabaseConfig, hasSupabaseConfig } = require('../config/supabase');
const { getMachineMap } = require('../config/runtimeConfig');
const { pushAttlogsToHris } = require('../services/hrisPush');
const { buildSourceKey } = require('../utils/sourceKey');
const {
  createRequestId,
  registerSession,
  getSession,
  finishSession,
} = require('../config/requestRegistry');

function parseDateString(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    return null;
  }

  const parsed = new Date(`${dateStr}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dayDiffInclusive(startDate, endDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((endDate.getTime() - startDate.getTime()) / msPerDay) + 1;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatLocalDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function resolveAttlogDateRange(body = {}) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const fallbackStart = formatLocalDate(yesterday);
  const fallbackEnd = formatLocalDate(today);
  const hasStartDate = Boolean(body.start_date);
  const hasEndDate = Boolean(body.end_date);
  const startDate = hasStartDate ? body.start_date : hasEndDate ? body.end_date : fallbackStart;
  const endDate = hasEndDate ? body.end_date : hasStartDate ? body.start_date : fallbackEnd;

  if (startDate > endDate) {
    return {
      start_date: endDate,
      end_date: startDate,
    };
  }

  return {
    start_date: startDate,
    end_date: endDate,
  };
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function splitDateRangesByTwoDays(startDate, endDate) {
  const ranges = [];
  let cursor = new Date(startDate);

  while (cursor <= endDate) {
    const chunkEnd = addDays(cursor, 1) <= endDate ? addDays(cursor, 1) : endDate;
    ranges.push({
      start_date: formatDate(cursor),
      end_date: formatDate(chunkEnd),
    });
    cursor = addDays(chunkEnd, 1);
  }

  return ranges;
}

async function requestGetAttlog(payload, apiToken) {
  const token = apiToken || FINGERSPOT_API_TOKEN;
  const response = await fetch(`${API_BASE_URL}/get_attlog`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
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

function parsePinValue(pin) {
  if (pin === undefined || pin === null) {
    return null;
  }

  const pinString = String(pin).trim();
  if (!pinString) {
    return null;
  }

  const numeric = Number(pinString);
  if (Number.isNaN(numeric)) {
    return pinString;
  }

  return numeric;
}

function normalizePinForPayload(pin, padLength) {
  if (typeof pin === 'number' && Number.isFinite(pin)) {
    const raw = String(Math.trunc(pin));
    return padLength ? raw.padStart(padLength, '0') : raw;
  }

  const pinString = String(pin).trim();
  if (!pinString) {
    return pinString;
  }

  if (/^\d+$/.test(pinString) && padLength) {
    return pinString.padStart(padLength, '0');
  }

  return pinString;
}

function sleep(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestGetUserInfo(payload, { signal, apiToken } = {}) {
  const url = `${API_BASE_URL}/get_userinfo`;
  const token = apiToken || FINGERSPOT_API_TOKEN;
  const fetchOptions = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Connection: 'keep-alive',
    },
    body: JSON.stringify(payload),
  };

  if (signal) {
    fetchOptions.signal = signal;
  }

  const response = await fetch(url, fetchOptions);

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

function normalizeAttlogRows(rows, meta) {
  return rows.map((row) => ({
    source_key: buildSourceKey(meta.cloud_id, row),
    cloud_id: meta.cloud_id,
    trans_id: meta.trans_id,
    pin: row.pin || null,
    scan_date: row.scan_date || null,
    verify: typeof row.verify === 'number' ? row.verify : null,
    status_scan: typeof row.status_scan === 'number' ? row.status_scan : null,
    photo_url: row.photo_url || null,
    requested_start_date: meta.start_date,
    requested_end_date: meta.end_date,
    raw_payload: row,
    fetched_at: new Date().toISOString(),
  }));
}

function deduplicateBySourceKey(rows) {
  const uniqueByKey = new Map();

  for (const row of rows) {
    // Keep the latest row for the same source_key within one upsert batch.
    uniqueByKey.set(row.source_key, row);
  }

  return Array.from(uniqueByKey.values());
}

async function saveAttlogsToSupabase(rows, meta) {
  if (!rows.length) {
    return {
      success: true,
      enabled: hasSupabaseConfig(),
      table: getSupabaseConfig().table,
      upserted: 0,
      message: 'Tidak ada data attlog untuk disimpan',
    };
  }

  if (!hasSupabaseConfig()) {
    return {
      success: false,
      enabled: false,
      table: getSupabaseConfig().table,
      upserted: 0,
      message: 'Konfigurasi Supabase belum lengkap di .env',
    };
  }

  const supabase = getSupabaseClient();
  const tableName = getSupabaseConfig().table;
  const normalizedRows = normalizeAttlogRows(rows, meta);
  const payload = deduplicateBySourceKey(normalizedRows);
  const duplicateCount = normalizedRows.length - payload.length;

  const { error } = await supabase
    .from(tableName)
    .upsert(payload, { onConflict: 'source_key' });

  if (error) {
    return {
      success: false,
      enabled: true,
      table: tableName,
      upserted: 0,
      duplicateDropped: duplicateCount,
      message: error.message,
    };
  }

  const machineMap = getMachineMap();
  const rowsForHris = payload.map((row) => ({
    ...row,
    machine_name: machineMap[row.cloud_id] || null,
  }));
  pushAttlogsToHris(rowsForHris).catch((pushError) => {
    console.error(`[hris-push] manual pull background error: ${pushError.message}`);
  });

  return {
    success: true,
    enabled: true,
    table: tableName,
    upserted: payload.length,
    duplicateDropped: duplicateCount,
    message: 'Data attlog berhasil di-upsert ke Supabase',
  };
}

function validateGetAttlogPayload(body) {
  const errors = [];

  if (!body.trans_id) {
    errors.push('trans_id wajib diisi');
  }

  if (!body.cloud_id) {
    errors.push('cloud_id wajib diisi');
  }

  const startDate = parseDateString(body.start_date);
  const endDate = parseDateString(body.end_date);

  if (!startDate) {
    errors.push('start_date tidak valid, format wajib YYYY-MM-DD');
  }

  if (!endDate) {
    errors.push('end_date tidak valid, format wajib YYYY-MM-DD');
  }

  if (startDate && endDate) {
    if (startDate > endDate) {
      errors.push('start_date tidak boleh lebih besar dari end_date');
    }

    const rangeDays = dayDiffInclusive(startDate, endDate);
    if (rangeDays > 2) {
      errors.push('range tanggal maksimal 2 hari per request');
    }
  }

  return errors;
}

function validateGetUserInfoPayload(body) {
  const errors = [];

  if (!body.trans_id) {
    errors.push('trans_id wajib diisi');
  }

  if (!body.cloud_id) {
    errors.push('cloud_id wajib diisi');
  }

  if (body.pin === undefined || body.pin === null || body.pin === '') {
    errors.push('pin wajib diisi');
  }

  return errors;
}

async function callGetUserInfo(req, res) {
  const payload = {
    trans_id: req.body?.trans_id,
    cloud_id: req.body?.cloud_id,
    pin: req.body?.pin,
  };

  const apiToken = getFingerspotToken(payload.cloud_id, req.body?.api_token);
  if (!apiToken) {
    return res.status(500).json({
      success: false,
      message: 'API Token belum dikonfigurasi untuk mesin ini',
    });
  }

  const errors = validateGetUserInfoPayload(payload);
  if (errors.length) {
    return res.status(400).json({
      success: false,
      message: 'Validasi request gagal',
      errors,
    });
  }

  try {
    const upstream = await requestGetUserInfo(payload, { apiToken });

    return res.status(upstream.status).json({
      success: upstream.ok,
      upstreamStatus: upstream.status,
      upstream: upstream.data,
      note: 'Detail userinfo akan dikirim oleh mesin melalui webhook endpoint Anda',
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      message: 'Gagal menghubungi API Fingerspot',
      error: error.message,
    });
  }
}

async function callGetUserInfoBulk(req, res) {
  const sourceCloudId = req.body?.cloud_id;
  const apiToken = getFingerspotToken(sourceCloudId, req.body?.api_token);
  
  if (!apiToken) {
    return res.status(500).json({
      success: false,
      message: 'API Token belum dikonfigurasi untuk mesin ini',
    });
  }
  const startPinRaw = parsePinValue(req.body?.start_pin ?? req.body?.from_pin ?? 1);
  const endPinRaw = parsePinValue(req.body?.end_pin ?? req.body?.to_pin ?? 1000);
  const pinWidth = Math.max(Number(req.body?.pin_width || 0), 0);
  const transPrefix = req.body?.trans_prefix || 'userinfo-bulk';
  const dryRun = Boolean(req.body?.dry_run);
  const includeResults =
    req.body?.include_results === undefined
      ? USERINFO_BULK_INCLUDE_RESULTS_DEFAULT
      : String(req.body?.include_results).toLowerCase() === 'true';
  const concurrency = Math.min(
    Math.max(Number(req.body?.concurrency || USERINFO_BULK_DEFAULT_CONCURRENCY), 1),
    20
  );
  const batchDelayMs = Math.max(
    Number(req.body?.batch_delay_ms ?? req.body?.delay_ms ?? USERINFO_BULK_BATCH_DELAY_MS),
    0
  );
  const requestId = req.body?.request_id || createRequestId('userinfo');
  registerSession(requestId, { prefix: 'userinfo-bulk', type: 'userinfo-bulk' });

  if (!sourceCloudId) {
    return res.status(400).json({
      success: false,
      message: 'cloud_id wajib diisi',
    });
  }

  const startNumeric = Number(startPinRaw);
  const endNumeric = Number(endPinRaw);
  if (Number.isNaN(startNumeric) || Number.isNaN(endNumeric)) {
    return res.status(400).json({
      success: false,
      message: 'start_pin dan end_pin harus berupa angka',
    });
  }

  if (startNumeric > endNumeric) {
    return res.status(400).json({
      success: false,
      message: 'start_pin tidak boleh lebih besar dari end_pin',
    });
  }

  const pinList = [];
  for (let pin = startNumeric; pin <= endNumeric; pin += 1) {
    pinList.push(normalizePinForPayload(pin, pinWidth));
  }

  if (pinList.length > USERINFO_BULK_MAX_PINS) {
    return res.status(400).json({
      success: false,
      message: `Jumlah PIN melebihi batas ${USERINFO_BULK_MAX_PINS}. Kecilkan range atau naikkan USERINFO_BULK_MAX_PINS.`,
      total_pins: pinList.length,
      max_allowed: USERINFO_BULK_MAX_PINS,
    });
  }

  if (dryRun) {
    finishSession(requestId, { status: 'completed', cancelled: false, total: pinList.length });
    return res.json({
      success: true,
      message: 'Dry run OK. Tidak ada request yang dikirim ke Fingerspot.',
      count: pinList.length,
      cloud_id: sourceCloudId,
      pins: pinList,
      concurrency,
      batch_delay_ms: batchDelayMs,
      request_id: requestId,
    });
  }

  const startTime = Date.now();
  const results = includeResults ? [] : null;
  const resultPreview = [];
  let processedCount = 0;
  let successCount = 0;
  let cancelled = false;
  let timedOutCount = 0;

  function pushResultRow(row) {
    if (results) {
      results.push(row);
      return;
    }

    if (!row.success && resultPreview.length < USERINFO_BULK_MAX_RESULT_ITEMS) {
      resultPreview.push({
        pin: row.pin,
        success: row.success,
        upstreamStatus: row.upstreamStatus,
        upstream: row.upstream,
      });
    }
  }

  async function processPin(pin, index) {
    if (getSession(requestId)?.cancelled) {
      cancelled = true;
      return;
    }

    const payload = {
      trans_id: `${transPrefix}-${Date.now()}-${index + 1}`,
      cloud_id: sourceCloudId,
      pin,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), USERINFO_REQUEST_TIMEOUT_MS);

      try {
        const upstream = await requestGetUserInfo(payload, { signal: controller.signal, apiToken });
        clearTimeout(timeoutId);
        const rowSuccess = upstream.ok && upstream.data?.success !== false;
        if (rowSuccess) {
          successCount += 1;
        }

        processedCount += 1;
        pushResultRow({
          pin,
          success: rowSuccess,
          upstreamStatus: upstream.status,
          upstream: upstream.data,
        });
      } catch (fetchError) {
        clearTimeout(timeoutId);
        throw fetchError;
      }
    } catch (error) {
      const isTimeout = error.name === 'AbortError';
      if (isTimeout) {
        timedOutCount += 1;
      }

      processedCount += 1;
      pushResultRow({
        pin,
        success: false,
        upstreamStatus: 0,
        upstream: { message: isTimeout ? `Timeout setelah ${USERINFO_REQUEST_TIMEOUT_MS}ms` : error.message },
      });
    }
  }

  // Pipeline-style processing: use a semaphore pattern for true concurrent throughput
  // instead of waiting for each batch to fully complete before starting the next
  const activeTasks = new Set();
  let pinIndex = 0;

  async function runPipeline() {
    while (pinIndex < pinList.length && !cancelled) {
      if (getSession(requestId)?.cancelled) {
        cancelled = true;
        break;
      }

      // Wait if we've reached max concurrent tasks
      while (activeTasks.size >= concurrency) {
        await Promise.race(activeTasks);
      }

      if (cancelled) break;

      const currentIndex = pinIndex;
      pinIndex += 1;
      const pin = pinList[currentIndex];

      const task = processPin(pin, currentIndex).then(() => {
        activeTasks.delete(task);
      });
      activeTasks.add(task);

      // Small stagger between launching requests to avoid thundering herd
      if (batchDelayMs > 0 && pinIndex < pinList.length) {
        await sleep(Math.ceil(batchDelayMs / concurrency));
      }
    }

    // Wait for remaining in-flight tasks
    if (activeTasks.size > 0) {
      await Promise.all(activeTasks);
    }
  }

  await runPipeline();

  const elapsedMs = Date.now() - startTime;
  const hasFailure = successCount !== processedCount;
  finishSession(requestId, {
    status: cancelled ? 'cancelled' : 'completed',
    cancelled,
    total: processedCount,
    successCount,
    elapsedMs,
  });

  const response = {
    success: !hasFailure,
    message: hasFailure
      ? 'Sebagian request get_userinfo gagal dikirim'
      : 'Semua request get_userinfo berhasil dikirim',
    cloud_id: sourceCloudId,
    total: processedCount,
    success_count: successCount,
    failed_count: processedCount - successCount,
    timed_out_count: timedOutCount,
    concurrency,
    batch_delay_ms: batchDelayMs,
    elapsed_ms: elapsedMs,
    cancelled,
    request_id: requestId,
    include_results: includeResults,
  };

  if (includeResults) {
    response.results = results;
  } else {
    response.results_preview = resultPreview;
    response.results_preview_count = resultPreview.length;
    response.results_preview_limited =
      hasFailure && processedCount - successCount > resultPreview.length;
  }

  return res.status(hasFailure ? 207 : 200).json(response);
}

async function callGetAttlog(req, res) {
  const payload = {
    trans_id: req.body?.trans_id,
    cloud_id: req.body?.cloud_id,
  };

  Object.assign(payload, resolveAttlogDateRange(req.body));

  const apiToken = getFingerspotToken(payload.cloud_id, req.body?.api_token);
  if (!apiToken) {
    return res.status(500).json({
      success: false,
      message: 'API Token belum dikonfigurasi untuk mesin ini',
    });
  }

  const errors = validateGetAttlogPayload(payload);
  if (errors.length) {
    return res.status(400).json({
      success: false,
      message: 'Validasi request gagal',
      errors,
    });
  }

  try {
    const upstream = await requestGetAttlog(payload, apiToken);
    const upstreamRows = Array.isArray(upstream.data?.data) ? upstream.data.data : [];
    const db = await saveAttlogsToSupabase(upstreamRows, payload);

    return res.status(upstream.status).json({
      success: upstream.ok,
      upstreamStatus: upstream.status,
      upstream: upstream.data,
      db,
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      message: 'Gagal menghubungi API Fingerspot',
      error: error.message,
    });
  }
}

async function callGetAttlogBulk(req, res) {
  const payload = {
    trans_id: req.body?.trans_id,
    cloud_id: req.body?.cloud_id,
  };

  Object.assign(payload, resolveAttlogDateRange(req.body));

  const errors = [];
  if (!payload.trans_id) {
    errors.push('trans_id wajib diisi');
  }
  if (!payload.cloud_id) {
    errors.push('cloud_id wajib diisi');
  }

  const startDate = parseDateString(payload.start_date);
  const endDate = parseDateString(payload.end_date);

  if (!startDate) {
    errors.push('start_date tidak valid, format wajib YYYY-MM-DD');
  }
  if (!endDate) {
    errors.push('end_date tidak valid, format wajib YYYY-MM-DD');
  }

  if (startDate && endDate) {
    if (startDate > endDate) {
      errors.push('start_date tidak boleh lebih besar dari end_date');
    }

    const rangeDays = dayDiffInclusive(startDate, endDate);
    if (rangeDays > MAX_BULK_DAYS) {
      errors.push(`range tanggal maksimal ${MAX_BULK_DAYS} hari per request bulk`);
    }
  }

  const apiToken = getFingerspotToken(payload.cloud_id, req.body?.api_token);
  if (!apiToken) {
    return res.status(500).json({
      success: false,
      message: 'API Token belum dikonfigurasi untuk mesin ini',
    });
  }

  if (errors.length) {
    return res.status(400).json({
      success: false,
      message: 'Validasi request gagal',
      errors,
    });
  }

  const ranges = splitDateRangesByTwoDays(startDate, endDate);
  const chunks = [];
  const mergedData = [];
  let hasFailedChunk = false;

  try {
    for (let i = 0; i < ranges.length; i += 1) {
      const range = ranges[i];
      const chunkPayload = {
        trans_id: `${payload.trans_id}-${i + 1}`,
        cloud_id: payload.cloud_id,
        start_date: range.start_date,
        end_date: range.end_date,
      };

      const upstream = await requestGetAttlog(chunkPayload, apiToken);
      const chunkData = Array.isArray(upstream.data?.data) ? upstream.data.data : [];

      if (!upstream.ok || upstream.data?.success === false) {
        hasFailedChunk = true;
      }

      mergedData.push(...chunkData);
      chunks.push({
        index: i + 1,
        request: chunkPayload,
        upstreamStatus: upstream.status,
        upstreamSuccess: upstream.data?.success ?? upstream.ok,
        count: chunkData.length,
      });
    }

    const db = await saveAttlogsToSupabase(mergedData, payload);

    return res.status(hasFailedChunk ? 207 : 200).json({
      success: !hasFailedChunk,
      message: hasFailedChunk
        ? 'Sebagian chunk gagal diproses, cek detail chunks'
        : 'Bulk get_attlog berhasil',
      totalChunks: chunks.length,
      totalData: mergedData.length,
      chunks,
      data: mergedData,
      db,
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      message: 'Gagal menghubungi API Fingerspot pada proses bulk',
      error: error.message,
    });
  }
}

module.exports = {
  callGetUserInfo,
  callGetUserInfoBulk,
  callGetAttlog,
  callGetAttlogBulk,
};
