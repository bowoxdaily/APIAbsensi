const fs = require('fs/promises');
const path = require('path');
const { createRequestId, registerSession, getSession, finishSession } = require('../config/requestRegistry');
const { getSupabaseClient, getSupabaseConfig, hasSupabaseConfig } = require('../config/supabase');

const logsFilePath = path.join(process.cwd(), 'logs', 'data.txt');
const API_BASE_URL = process.env.FINGERSPOT_BASE_URL || 'https://developer.fingerspot.io/api';
const FINGERSPOT_API_TOKEN = process.env.FINGERSPOT_API_TOKEN || '';

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

  return Array.from(latestByPin.values()).sort((a, b) => a.pin.localeCompare(b.pin, 'en'));
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
    dryRun: Boolean(input.dry_run ?? input.dryRun),
    limit: Math.max(Number(input.limit || 1000), 1),
    concurrency: Math.min(Math.max(Number(input.concurrency || 3), 1), 10),
  };
}

async function runEmployeeSync(rawConfig = {}) {
  const {
    sourceCloudId,
    targetCloudId,
    transPrefix,
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
  const users = extractUsersFromRecords(records, sourceCloudId).slice(0, limit);

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

  for (let i = 0; i < users.length; i += concurrency) {
    if (getSession(requestId)?.cancelled) {
      cancelled = true;
      break;
    }

    const batch = users.slice(i, i + concurrency);
    await Promise.all(batch.map((user, batchIndex) => processUser(user, i + batchIndex)));
  }

  const successCount = results.filter((item) => item.success).length;
  const hasFailure = successCount !== results.length;
  finishSession(requestId, {
    status: cancelled ? 'cancelled' : 'completed',
    cancelled,
    total: results.length,
    successCount,
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
      request_id: requestId,
      total: results.length,
      success_count: successCount,
      failed_count: results.length - successCount,
      cancelled,
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
