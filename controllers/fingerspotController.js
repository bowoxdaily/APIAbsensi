const API_BASE_URL = process.env.FINGERSPOT_BASE_URL || 'https://developer.fingerspot.io/api';
const FINGERSPOT_API_TOKEN = process.env.FINGERSPOT_API_TOKEN || '';
const MAX_BULK_DAYS = 60;
const { getSupabaseClient, getSupabaseConfig, hasSupabaseConfig } = require('../config/supabase');
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

async function requestGetAttlog(payload) {
  const response = await fetch(`${API_BASE_URL}/get_attlog`, {
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

async function requestGetUserInfo(payload) {
  const response = await fetch(`${API_BASE_URL}/get_userinfo`, {
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

function buildSourceKey(cloudId, row) {
  const pin = row?.pin ?? '';
  const scanDate = row?.scan_date ?? '';
  const verify = row?.verify ?? '';
  const statusScan = row?.status_scan ?? '';
  return `${cloudId}|${pin}|${scanDate}|${verify}|${statusScan}`;
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
  if (!FINGERSPOT_API_TOKEN) {
    return res.status(500).json({
      success: false,
      message: 'FINGERSPOT_API_TOKEN belum diisi di .env',
    });
  }

  const payload = {
    trans_id: req.body?.trans_id,
    cloud_id: req.body?.cloud_id,
    pin: req.body?.pin,
  };

  const errors = validateGetUserInfoPayload(payload);
  if (errors.length) {
    return res.status(400).json({
      success: false,
      message: 'Validasi request gagal',
      errors,
    });
  }

  try {
    const upstream = await requestGetUserInfo(payload);

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
  if (!FINGERSPOT_API_TOKEN) {
    return res.status(500).json({
      success: false,
      message: 'FINGERSPOT_API_TOKEN belum diisi di .env',
    });
  }

  const sourceCloudId = req.body?.cloud_id;
  const startPinRaw = parsePinValue(req.body?.start_pin ?? req.body?.from_pin ?? 1);
  const endPinRaw = parsePinValue(req.body?.end_pin ?? req.body?.to_pin ?? 1000);
  const pinWidth = Math.max(Number(req.body?.pin_width || 0), 0);
  const transPrefix = req.body?.trans_prefix || 'userinfo-bulk';
  const dryRun = Boolean(req.body?.dry_run);
  const concurrency = Math.min(Math.max(Number(req.body?.concurrency || 5), 1), 10);
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

  if (dryRun) {
    finishSession(requestId, { status: 'completed', cancelled: false, total: pinList.length });
    return res.json({
      success: true,
      message: 'Dry run OK. Tidak ada request yang dikirim ke Fingerspot.',
      count: pinList.length,
      cloud_id: sourceCloudId,
      pins: pinList,
      request_id: requestId,
    });
  }

  const results = [];
  let successCount = 0;
  let cancelled = false;

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
      const upstream = await requestGetUserInfo(payload);
      const rowSuccess = upstream.ok && upstream.data?.success !== false;
      if (rowSuccess) {
        successCount += 1;
      }

      results.push({
        pin,
        success: rowSuccess,
        upstreamStatus: upstream.status,
        upstream: upstream.data,
      });
    } catch (error) {
      results.push({
        pin,
        success: false,
        upstreamStatus: 0,
        upstream: { message: error.message },
      });
    }
  }

  for (let i = 0; i < pinList.length; i += concurrency) {
    if (getSession(requestId)?.cancelled) {
      cancelled = true;
      break;
    }

    const batch = pinList.slice(i, i + concurrency);
    await Promise.all(batch.map((pin, batchIndex) => processPin(pin, i + batchIndex)));
  }

  const hasFailure = successCount !== results.length;
  finishSession(requestId, {
    status: cancelled ? 'cancelled' : 'completed',
    cancelled,
    total: results.length,
    successCount,
  });

  return res.status(hasFailure ? 207 : 200).json({
    success: !hasFailure,
    message: hasFailure
      ? 'Sebagian request get_userinfo gagal dikirim'
      : 'Semua request get_userinfo berhasil dikirim',
    cloud_id: sourceCloudId,
    total: results.length,
    success_count: successCount,
    failed_count: results.length - successCount,
    cancelled,
    request_id: requestId,
    results,
  });
}

async function callGetAttlog(req, res) {
  if (!FINGERSPOT_API_TOKEN) {
    return res.status(500).json({
      success: false,
      message: 'FINGERSPOT_API_TOKEN belum diisi di .env',
    });
  }

  const payload = {
    trans_id: req.body?.trans_id,
    cloud_id: req.body?.cloud_id,
    start_date: req.body?.start_date,
    end_date: req.body?.end_date,
  };

  const errors = validateGetAttlogPayload(payload);
  if (errors.length) {
    return res.status(400).json({
      success: false,
      message: 'Validasi request gagal',
      errors,
    });
  }

  try {
    const upstream = await requestGetAttlog(payload);
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
  if (!FINGERSPOT_API_TOKEN) {
    return res.status(500).json({
      success: false,
      message: 'FINGERSPOT_API_TOKEN belum diisi di .env',
    });
  }

  const payload = {
    trans_id: req.body?.trans_id,
    cloud_id: req.body?.cloud_id,
    start_date: req.body?.start_date,
    end_date: req.body?.end_date,
  };

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

      const upstream = await requestGetAttlog(chunkPayload);
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
