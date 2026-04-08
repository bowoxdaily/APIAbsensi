const fs = require('fs/promises');
const path = require('path');
const { getMachineMap } = require('../config/runtimeConfig');
const { getSupabaseClient, getSupabaseConfig, hasSupabaseConfig } = require('../config/supabase');

const logsDirPath = path.join(process.cwd(), 'logs');
const logsFilePath = path.join(logsDirPath, 'attlog.txt');
const masterLogsFilePath = path.join(logsDirPath, 'data.txt');

function toDateKey(value) {
  if (!value) {
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function formatLocalDateKey(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function getDefaultDateRange() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  return {
    start_date: formatLocalDateKey(yesterday),
    end_date: formatLocalDateKey(today),
    defaulted: true,
  };
}

function resolveDateRange(query = {}) {
  const startInput = query.start_date || query.startDate || query.from || query.date_from || null;
  const endInput = query.end_date || query.endDate || query.to || query.date_to || null;

  const startDate = toDateKey(startInput);
  const endDate = toDateKey(endInput);

  if (!startDate && !endDate) {
    return getDefaultDateRange();
  }

  const resolvedStart = startDate || endDate;
  const resolvedEnd = endDate || startDate;

  if (resolvedStart && resolvedEnd && resolvedStart > resolvedEnd) {
    return {
      start_date: resolvedEnd,
      end_date: resolvedStart,
      defaulted: false,
    };
  }

  return {
    start_date: resolvedStart,
    end_date: resolvedEnd,
    defaulted: false,
  };
}

function extractRecordDateKey(record) {
  return (
    toDateKey(record?.scan_date) ||
    toDateKey(record?.scanDate) ||
    toDateKey(record?.received_at) ||
    toDateKey(record?.receivedAt) ||
    toDateKey(record?.fetched_at) ||
    toDateKey(record?.fetchedAt) ||
    null
  );
}

function matchesDateRange(record, dateRange) {
  if (!dateRange?.start_date || !dateRange?.end_date) {
    return true;
  }

  const dateKey = extractRecordDateKey(record);
  if (!dateKey) {
    return false;
  }

  return dateKey >= dateRange.start_date && dateKey <= dateRange.end_date;
}

function getRecordSortTime(record) {
  const value =
    record?.receivedAt ||
    record?.received_at ||
    record?.fetched_at ||
    record?.fetchedAt ||
    record?.scan_date ||
    record?.scanDate ||
    null;
  const time = new Date(value || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function sortNewestFirst(left, right) {
  return getRecordSortTime(right) - getRecordSortTime(left);
}

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
  const dateRange = resolveDateRange(req.query);

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
    .filter(Boolean)
    .filter((record) => matchesDateRange(record, dateRange))
    .sort(sortNewestFirst);

  return res.json({
    success: true,
    date_range: dateRange,
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
  const dateRange = resolveDateRange(req.query);

  if (!cloudIds.length) {
    return res.json({
      success: true,
      source: 'empty',
      date_range: dateRange,
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

    if (dateRange.start_date) {
      query = query.gte('scan_date', dateRange.start_date);
    }

    if (dateRange.end_date) {
      query = query.lte('scan_date', `${dateRange.end_date} 23:59:59`);
    }

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
      .map(normalizeWebhookAttlogRecord)
      .filter((record) => matchesDateRange(record, dateRange));

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
    .map(normalizeWebhookAttlogRecord)
    .filter((record) => matchesDateRange(record, dateRange));

  mergedRows.push(...historicalItems);

  const uniqueByKey = new Map();
  for (const row of mergedRows) {
    const key = row.source_key || `${row.source_type}|${row.cloud_id}|${row.pin}|${row.scan_date}`;
    uniqueByKey.set(key, row);
  }

  const ordered = Array.from(uniqueByKey.values()).sort(sortNewestFirst);

  const result = limit > 0 ? ordered.slice(0, limit) : ordered;

  return res.json({
    success: true,
    source: includeSupabase && hasSupabaseConfig() ? 'merged' : 'logs',
    date_range: dateRange,
    count: result.length,
    machines: cloudIds,
    data: result,
  });
}

module.exports = {
  getAttlog,
  getCombinedAttlog,
};
