const fs = require('fs/promises');
const path = require('path');
const { getMachineMap } = require('../config/runtimeConfig');
const { getSupabaseClient, getSupabaseConfig, hasSupabaseConfig } = require('../config/supabase');

const logsDirPath = path.join(process.cwd(), 'logs');
const logsFilePath = path.join(logsDirPath, 'attlog.txt');
const masterLogsFilePath = path.join(logsDirPath, 'data.txt');

async function ensureLogFile() {
  await fs.mkdir(path.dirname(logsFilePath), { recursive: true });
  try {
    await fs.access(logsFilePath);
  } catch (error) {
    await fs.writeFile(logsFilePath, '', 'utf8');
  }
}

async function ensureMasterLogFile() {
  await fs.mkdir(path.dirname(masterLogsFilePath), { recursive: true });
  try {
    await fs.access(masterLogsFilePath);
  } catch (error) {
    await fs.writeFile(masterLogsFilePath, '', 'utf8');
  }
}

async function getAttlog(req, res) {
  await ensureLogFile();

  const raw = await fs.readFile(logsFilePath, 'utf8');
  const data = raw
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

  return res.json({
    success: true,
    count: data.length,
    data,
  });
}

function parseCloudIdFilter(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function getRawWebhookRecords() {
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

async function getRawMasterRecords() {
  await ensureMasterLogFile();

  const raw = await fs.readFile(masterLogsFilePath, 'utf8');
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

function normalizeWebhookAttlogRecord(record) {
  const data = record?.body?.data || {};
  const cloudId = record?.machineId || record?.body?.cloud_id || record?.body?.cloudId || null;
  const scanDate = data.scan || data.scan_date || record?.receivedAt || null;

  return {
    source_type: 'webhook',
    source_key: `webhook|${record?.id || ''}`,
    cloud_id: cloudId,
    trans_id: record?.body?.trans_id || null,
    pin: data.pin || null,
    scan_date: scanDate,
    verify: typeof data.verify === 'number' ? data.verify : null,
    status_scan: typeof data.status_scan === 'number' ? data.status_scan : null,
    photo_url: data.photo_url || null,
    work_code: data.work_code || null,
    raw_payload: record?.body || null,
    received_at: record?.receivedAt || null,
  };
}

function normalizeSupabaseAttlogRecord(record) {
  return {
    source_type: 'supabase',
    source_key: record?.source_key || null,
    cloud_id: record?.cloud_id || null,
    trans_id: record?.trans_id || null,
    pin: record?.pin || null,
    scan_date: record?.scan_date || null,
    verify: record?.verify ?? null,
    status_scan: record?.status_scan ?? null,
    photo_url: record?.photo_url || null,
    raw_payload: record?.raw_payload || null,
    requested_start_date: record?.requested_start_date || null,
    requested_end_date: record?.requested_end_date || null,
    fetched_at: record?.fetched_at || null,
  };
}

function buildRegisteredMachineList(filterCloudIds = []) {
  const machineMap = getMachineMap();
  const registeredCloudIds = Object.keys(machineMap);

  if (!filterCloudIds.length) {
    return registeredCloudIds;
  }

  return registeredCloudIds.filter((cloudId) => filterCloudIds.includes(cloudId));
}

async function getCombinedAttlog(req, res) {
  const filterCloudIds = parseCloudIdFilter(req.query.cloud_id || req.query.cloudId || req.query.machine_id || req.query.machineId);
  const limit = Math.max(Number(req.query.limit || 0), 0);
  const cloudIds = buildRegisteredMachineList(filterCloudIds);
  const includeLogs = String(req.query.include_logs || 'true').toLowerCase() !== 'false';
  const includeSupabase = String(req.query.include_supabase || 'true').toLowerCase() !== 'false';

  if (!cloudIds.length) {
    return res.json({
      success: true,
      source: 'empty',
      count: 0,
      machines: [],
      data: [],
    });
  }

  const mergedRows = [];

  if (includeSupabase && hasSupabaseConfig()) {
    const supabase = getSupabaseClient();
    const tableName = getSupabaseConfig().table;
    let query = supabase.from(tableName).select('*').in('cloud_id', cloudIds).order('fetched_at', { ascending: false });

    if (limit > 0) {
      query = query.limit(limit);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(502).json({
        success: false,
        message: 'Gagal mengambil attlog gabungan dari Supabase',
        error: error.message,
      });
    }

    mergedRows.push(...data.map(normalizeSupabaseAttlogRecord));
  }

  if (includeLogs) {
    const records = await getRawWebhookRecords();
    const items = records
      .filter((item) => {
        if (item?.body?.type !== 'attlog') {
          return false;
        }

        const machineId = item?.machineId || item?.body?.cloud_id || item?.body?.cloudId || null;
        if (!machineId) {
          return false;
        }

        return cloudIds.includes(String(machineId));
      })
      .map(normalizeWebhookAttlogRecord);

    mergedRows.push(...items);
  }

  const historicalRecords = await getRawMasterRecords();
  const historicalItems = historicalRecords
    .filter((item) => item?.body?.type === 'attlog')
    .filter((item) => {
      const machineId = item?.machineId || item?.body?.cloud_id || item?.body?.cloudId || null;
      if (!machineId) {
        return false;
      }

      return cloudIds.includes(String(machineId));
    })
    .map(normalizeWebhookAttlogRecord);

  mergedRows.push(...historicalItems);

  const uniqueByKey = new Map();
  for (const row of mergedRows) {
    const key = row.source_key || `${row.source_type}|${row.cloud_id}|${row.pin}|${row.scan_date}`;
    uniqueByKey.set(key, row);
  }

  const ordered = Array.from(uniqueByKey.values()).sort((left, right) => {
    const leftTime = new Date(left.fetched_at || left.received_at || left.scan_date || 0).getTime();
    const rightTime = new Date(right.fetched_at || right.received_at || right.scan_date || 0).getTime();
    return rightTime - leftTime;
  });

  const result = limit > 0 ? ordered.slice(0, limit) : ordered;

  return res.json({
    success: true,
    source: includeSupabase && hasSupabaseConfig() ? 'merged' : 'logs',
    count: result.length,
    machines: cloudIds,
    data: result,
  });
}

module.exports = {
  getAttlog,
  getCombinedAttlog,
};
