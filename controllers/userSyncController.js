const fs = require('fs/promises');
const path = require('path');

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

async function getEmployees(req, res) {
  const sourceCloudId = req.query.source_cloud_id || req.query.cloud_id || null;
  const limit = Math.max(Number(req.query.limit || 500), 1);

  const records = await getWebhookRecords();
  const users = extractUsersFromRecords(records, sourceCloudId).slice(0, limit);

  return res.json({
    success: true,
    count: users.length,
    data: users,
  });
}

async function syncEmployeesToMachine(req, res) {
  if (!FINGERSPOT_API_TOKEN) {
    return res.status(500).json({
      success: false,
      message: 'FINGERSPOT_API_TOKEN belum diisi di .env',
    });
  }

  const sourceCloudId = req.body?.source_cloud_id;
  const targetCloudId = req.body?.target_cloud_id;
  const transPrefix = req.body?.trans_prefix || 'sync-user';
  const dryRun = Boolean(req.body?.dry_run);
  const limit = Math.max(Number(req.body?.limit || 1000), 1);

  if (!sourceCloudId) {
    return res.status(400).json({
      success: false,
      message: 'source_cloud_id wajib diisi',
    });
  }

  if (!targetCloudId) {
    return res.status(400).json({
      success: false,
      message: 'target_cloud_id wajib diisi',
    });
  }

  const records = await getWebhookRecords();
  const users = extractUsersFromRecords(records, sourceCloudId).slice(0, limit);

  if (!users.length) {
    return res.status(404).json({
      success: false,
      message: 'Tidak ada data userinfo dari mesin sumber. Jalankan get_userinfo dulu sampai webhook masuk.',
      count: 0,
      data: [],
    });
  }

  if (dryRun) {
    return res.json({
      success: true,
      message: 'Dry run OK. Tidak ada request yang dikirim ke Fingerspot.',
      count: users.length,
      target_cloud_id: targetCloudId,
      data: users,
    });
  }

  const results = [];
  let successCount = 0;

  for (let i = 0; i < users.length; i += 1) {
    const user = users[i];
    const payload = {
      type: 'set_userinfo',
      trans_id: `${transPrefix}-${Date.now()}-${i + 1}`,
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
      if (rowSuccess) {
        successCount += 1;
      }

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

  const hasFailure = successCount !== results.length;

  return res.status(hasFailure ? 207 : 200).json({
    success: !hasFailure,
    message: hasFailure
      ? 'Sebagian user gagal dikirim ke mesin tujuan'
      : 'Semua user berhasil dikirim ke mesin tujuan',
    source_cloud_id: sourceCloudId,
    target_cloud_id: targetCloudId,
    total: results.length,
    success_count: successCount,
    failed_count: results.length - successCount,
    results,
  });
}

module.exports = {
  getEmployees,
  syncEmployeesToMachine,
};
