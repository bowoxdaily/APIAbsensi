/**
 * attlogCron.js
 * Scheduler otomatis: pull attlog dari API Fingerspot untuk semua mesin terdaftar
 * kemudian simpan ke Supabase. Webhook tetap aktif sebagai fallback real-time.
 */

const { getMachineMap } = require('./runtimeConfig');
const { getSupabaseClient, getSupabaseConfig, hasSupabaseConfig } = require('./supabase');

const API_BASE_URL = process.env.FINGERSPOT_BASE_URL || 'https://developer.fingerspot.io/api';
const FINGERSPOT_API_TOKEN = process.env.FINGERSPOT_API_TOKEN || '';

// Konfigurasi dari .env
const ATTLOG_CRON_ENABLED = String(process.env.ENABLE_ATTLOG_CRON || 'false').toLowerCase() === 'true';
const ATTLOG_CRON_INTERVAL_MINUTES = Math.max(Number(process.env.ATTLOG_CRON_INTERVAL_MINUTES || 15), 1);
const ATTLOG_CRON_LOOKBACK_HOURS = Math.max(Number(process.env.ATTLOG_CRON_LOOKBACK_HOURS || 2), 1);
const ATTLOG_CRON_DELAY_BETWEEN_MACHINES_MS = Math.max(Number(process.env.ATTLOG_CRON_DELAY_MS || 2000), 500);

function getFingerspotToken(cloudId) {
  if (process.env.FINGERSPOT_API_TOKENS_JSON) {
    try {
      const tokensMap = JSON.parse(process.env.FINGERSPOT_API_TOKENS_JSON);
      if (cloudId && tokensMap[cloudId]) {
        return tokensMap[cloudId];
      }
    } catch (e) {
      // fallback ke token global
    }
  }
  return FINGERSPOT_API_TOKEN;
}

function formatLocalDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function buildDateRange() {
  const now = new Date();
  const lookbackMs = ATTLOG_CRON_LOOKBACK_HOURS * 60 * 60 * 1000;
  const from = new Date(now.getTime() - lookbackMs);

  return {
    start_date: formatLocalDate(from),
    end_date: formatLocalDate(now),
  };
}

function buildSourceKey(cloudId, row) {
  const pin = row?.pin ?? '';
  const scanDate = row?.scan_date ?? '';
  const verify = row?.verify ?? '';
  const statusScan = row?.status_scan ?? '';
  return `${cloudId}|${pin}|${scanDate}|${verify}|${statusScan}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pullAttlogForMachine(cloudId, machineName) {
  const apiToken = getFingerspotToken(cloudId);
  if (!apiToken) {
    console.warn(`[attlog-cron] Mesin ${machineName} (${cloudId}): tidak ada API token, skip`);
    return { success: false, count: 0 };
  }

  const dateRange = buildDateRange();
  const payload = {
    trans_id: `attlog-cron-${cloudId}-${Date.now()}`,
    cloud_id: cloudId,
    start_date: dateRange.start_date,
    end_date: dateRange.end_date,
  };

  let response;
  try {
    response = await fetch(`${API_BASE_URL}/get_attlog`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (fetchError) {
    console.error(`[attlog-cron] Mesin ${machineName} (${cloudId}): gagal request — ${fetchError.message}`);
    return { success: false, count: 0 };
  }

  let data;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    console.error(`[attlog-cron] Mesin ${machineName} (${cloudId}): response bukan JSON`);
    return { success: false, count: 0 };
  }

  if (!response.ok || data?.success === false) {
    console.warn(
      `[attlog-cron] Mesin ${machineName} (${cloudId}): API gagal — status=${response.status} msg=${data?.message || '-'}`
    );
    return { success: false, count: 0 };
  }

  const rows = Array.isArray(data?.data) ? data.data : [];
  if (!rows.length) {
    console.log(`[attlog-cron] Mesin ${machineName} (${cloudId}): tidak ada data baru (${dateRange.start_date} s/d ${dateRange.end_date})`);
    return { success: true, count: 0 };
  }

  // Simpan ke Supabase jika tersedia
  if (hasSupabaseConfig()) {
    const supabase = getSupabaseClient();
    const tableName = getSupabaseConfig().table;

    const normalized = rows.map((row) => ({
      source_key: buildSourceKey(cloudId, row),
      cloud_id: cloudId,
      trans_id: payload.trans_id,
      pin: row.pin || null,
      scan_date: row.scan_date || null,
      verify: typeof row.verify === 'number' ? row.verify : null,
      status_scan: typeof row.status_scan === 'number' ? row.status_scan : null,
      photo_url: row.photo_url || null,
      requested_start_date: dateRange.start_date,
      requested_end_date: dateRange.end_date,
      raw_payload: row,
      fetched_at: new Date().toISOString(),
    }));

    // Deduplikasi sebelum upsert
    const uniqueMap = new Map();
    for (const row of normalized) {
      uniqueMap.set(row.source_key, row);
    }
    const payload_rows = Array.from(uniqueMap.values());

    const { error } = await supabase
      .from(tableName)
      .upsert(payload_rows, { onConflict: 'source_key' });

    if (error) {
      console.error(`[attlog-cron] Mesin ${machineName} (${cloudId}): gagal simpan Supabase — ${error.message}`);
      return { success: false, count: rows.length };
    }

    console.log(
      `[attlog-cron] Mesin ${machineName} (${cloudId}): berhasil upsert ${payload_rows.length} record (${dateRange.start_date} s/d ${dateRange.end_date})`
    );
  } else {
    console.log(
      `[attlog-cron] Mesin ${machineName} (${cloudId}): ${rows.length} record diterima tapi Supabase belum dikonfigurasi`
    );
  }

  return { success: true, count: rows.length };
}

async function runAttlogCronJob() {
  const machineMap = getMachineMap();
  const cloudIds = Object.keys(machineMap);

  if (!cloudIds.length) {
    console.warn('[attlog-cron] Tidak ada mesin terdaftar di MACHINE_MAP, skip');
    return;
  }

  console.log(`[attlog-cron] Mulai pull attlog untuk ${cloudIds.length} mesin...`);
  let totalRecords = 0;

  for (const cloudId of cloudIds) {
    const machineName = machineMap[cloudId] || cloudId;
    const result = await pullAttlogForMachine(cloudId, machineName);
    totalRecords += result.count;

    // Jeda antar mesin agar tidak membanjiri API Fingerspot sekaligus
    if (cloudIds.indexOf(cloudId) < cloudIds.length - 1) {
      await sleep(ATTLOG_CRON_DELAY_BETWEEN_MACHINES_MS);
    }
  }

  console.log(`[attlog-cron] Selesai. Total record baru: ${totalRecords}`);
}

/**
 * Inisialisasi attlog cron — dipanggil dari server.js
 * @param {boolean} runImmediately - Langsung pull saat server start jika true
 */
function initAttlogCron(runImmediately = true) {
  if (!ATTLOG_CRON_ENABLED) {
    console.log('[attlog-cron] Dinonaktifkan (ENABLE_ATTLOG_CRON=false)');
    return;
  }

  console.log(
    `[attlog-cron] Aktif: pull tiap ${ATTLOG_CRON_INTERVAL_MINUTES} menit, lookback ${ATTLOG_CRON_LOOKBACK_HOURS} jam`
  );

  let isRunning = false;

  const safeRun = async () => {
    if (isRunning) {
      console.log('[attlog-cron] Skip: job sebelumnya masih berjalan');
      return;
    }
    isRunning = true;
    try {
      await runAttlogCronJob();
    } catch (error) {
      console.error(`[attlog-cron] Error tidak terduga: ${error.message}`);
    } finally {
      isRunning = false;
    }
  };

  if (runImmediately) {
    safeRun();
  }

  setInterval(safeRun, ATTLOG_CRON_INTERVAL_MINUTES * 60 * 1000);
}

module.exports = { initAttlogCron, runAttlogCronJob };
