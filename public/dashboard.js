function pretty(data) {
  return JSON.stringify(data, null, 2);
}

function parseBool(value) {
  return String(value) === 'true';
}

const activeRequests = {
  bulk: null,
  sync: null,
};

let rawLogsCache = [];
let selectedRawLogId = null;
let rawLogTypeTab = 'all';
let rawLogsRefreshTimer = null;

function getAuthHeaders() {
  const token = document.getElementById('apiToken').value.trim();
  if (!token) {
    return {};
  }

  return {
    'x-api-token': token,
    Authorization: `Bearer ${token}`,
  };
}

async function callApi(url, method = 'GET', body) {
  const headers = {
    'Content-Type': 'application/json',
    ...getAuthHeaders(),
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : { raw: '' };
  } catch (error) {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function cancelRequest(requestId) {
  if (!requestId) {
    return null;
  }

  return callApi(`/api/requests/${encodeURIComponent(requestId)}/cancel`, 'POST');
}

function applyDefaultsToForm() {
  const source = document.getElementById('defaultSourceCloudId').value.trim() || 'GQ5179635';
  const target = document.getElementById('defaultTargetCloudId').value.trim() || 'GQ5778665';

  document.getElementById('bulkCloudId').value = source;
  document.getElementById('employeesCloudId').value = source;
  document.getElementById('syncSourceCloudId').value = source;
  document.getElementById('syncTargetCloudId').value = target;
}

function saveLocalDefaults() {
  const payload = {
    token: document.getElementById('apiToken').value,
    source: document.getElementById('defaultSourceCloudId').value,
    target: document.getElementById('defaultTargetCloudId').value,
  };

  localStorage.setItem('absensi-ui-defaults', JSON.stringify(payload));
}

function loadLocalDefaults() {
  const raw = localStorage.getItem('absensi-ui-defaults');
  if (!raw) {
    applyDefaultsToForm();
    return;
  }

  try {
    const data = JSON.parse(raw);
    document.getElementById('apiToken').value = data.token || '';
    document.getElementById('defaultSourceCloudId').value = data.source || 'GQ5179635';
    document.getElementById('defaultTargetCloudId').value = data.target || 'GQ5778665';
  } catch (error) {
    document.getElementById('defaultSourceCloudId').value = 'GQ5179635';
    document.getElementById('defaultTargetCloudId').value = 'GQ5778665';
  }

  applyDefaultsToForm();
}

async function runBulk(forceDryRun) {
  const requestId = `bulk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  activeRequests.bulk = requestId;
  const body = {
    cloud_id: document.getElementById('bulkCloudId').value.trim(),
    start_pin: Number(document.getElementById('bulkStartPin').value),
    end_pin: Number(document.getElementById('bulkEndPin').value),
    pin_width: Number(document.getElementById('bulkPinWidth').value),
    trans_prefix: 'userinfo-bulk-ui',
    concurrency: Number(document.getElementById('bulkConcurrency').value),
    dry_run: forceDryRun === true ? true : parseBool(document.getElementById('bulkDryRun').value),
    request_id: requestId,
  };

  const resultEl = document.getElementById('bulkResult');
  resultEl.textContent = 'Sedang kirim request bulk...';
  const res = await callApi('/api/fingerspot/get-userinfo-bulk', 'POST', body);
  resultEl.textContent = pretty({ status: res.status, ...res.data });
  activeRequests.bulk = res.data?.request_id || null;
}

async function stopBulk() {
  const resultEl = document.getElementById('bulkResult');
  const response = await cancelRequest(activeRequests.bulk);

  if (!response) {
    resultEl.textContent = 'Tidak ada bulk request aktif';
    return;
  }

  resultEl.textContent = pretty({ status: response.status, ...response.data });
}

async function loadEmployees() {
  const cloudId = document.getElementById('employeesCloudId').value.trim();
  const limit = Number(document.getElementById('employeesLimit').value);
  const query = new URLSearchParams();

  if (cloudId) {
    query.set('source_cloud_id', cloudId);
  }
  query.set('limit', String(limit));

  const result = await callApi(`/api/employees?${query.toString()}`, 'GET');
  document.getElementById('employeeCount').textContent = String(result.data?.count || 0);

  const tbody = document.getElementById('employeesTableBody');
  const rows = result.data?.data || [];

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5">Belum ada data</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(
      (item) => `<tr>
      <td>${item.pin || ''}</td>
      <td>${item.name || ''}</td>
      <td>${item.privilege || ''}</td>
      <td>${item.finger || ''}</td>
      <td>${item.face || ''}</td>
    </tr>`
    )
    .join('');
}

function getRawLogType(record) {
  return String(record?.body?.type || 'other').toLowerCase();
}

function getRawLogSearchText(record) {
  const body = record?.body || {};
  const data = body?.data || {};
  return [
    record?.id,
    record?.machineId,
    record?.machineName,
    record?.receivedAt,
    body?.type,
    body?.cloud_id,
    body?.trans_id,
    data?.pin,
    data?.name,
    data?.scan,
    data?.scan_date,
    data?.status,
    data?.status_scan,
    data?.verify,
  ]
    .filter(Boolean)
    .map((item) => String(item).toLowerCase())
    .join(' ');
}

function getRawLogSummary(record) {
  const type = getRawLogType(record);
  const data = record?.body?.data || {};

  if (type === 'attlog') {
    return `${data.pin || '-'} | ${data.scan || data.scan_date || '-'}`;
  }

  if (type === 'get_userinfo') {
    return `${data.pin || '-'} | ${data.name || '-'} | ${data.privilege || '0'}`;
  }

  if (type === 'set_userinfo') {
    return `status=${data.status || '-'}`;
  }

  return JSON.stringify(data || {}, null, 0).slice(0, 80);
}

function renderRawLogsTable(records) {
  const tbody = document.getElementById('rawLogsTableBody');
  const detailEl = document.getElementById('rawLogsDetail');
  const countEl = document.getElementById('rawLogsCount');
  const statusEl = document.getElementById('rawLogsStatus');

  countEl.textContent = String(records.length);

  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="5">Belum ada data</td></tr>';
    detailEl.textContent = 'Tidak ada log yang cocok dengan filter';
    statusEl.textContent = 'Tidak ada data untuk filter yang dipilih';
    selectedRawLogId = null;
    return;
  }

  tbody.innerHTML = records
    .map((record) => {
      const isSelected = record.id === selectedRawLogId;
      return `<tr class="raw-log-row ${isSelected ? 'is-selected' : ''}" data-log-id="${record.id}">
        <td>${record.receivedAt || ''}</td>
        <td>${record.machineName || record.machineId || ''}</td>
        <td>${getRawLogType(record)}</td>
        <td>${record.body?.data?.pin || record.body?.pin || ''}</td>
        <td>${getRawLogSummary(record)}</td>
      </tr>`;
    })
    .join('');

  const selectedRecord = records.find((record) => record.id === selectedRawLogId) || records[0];
  selectedRawLogId = selectedRecord.id;
  detailEl.textContent = pretty(selectedRecord);
  statusEl.textContent = `Menampilkan ${records.length} log terbaru`;
}

function applyRawLogsFilters() {
  const searchTerm = document.getElementById('rawLogsSearch').value.trim().toLowerCase();

  return rawLogsCache.filter((record) => {
    const type = getRawLogType(record);
    if (rawLogTypeTab !== 'all') {
      if (rawLogTypeTab === 'other') {
        if (type === 'attlog' || type === 'get_userinfo' || type === 'set_userinfo') {
          return false;
        }
      } else if (type !== rawLogTypeTab) {
        return false;
      }
    }

    if (searchTerm && !getRawLogSearchText(record).includes(searchTerm)) {
      return false;
    }

    return true;
  });
}

function setRawLogTab(nextTab) {
  rawLogTypeTab = nextTab;

  document.querySelectorAll('[data-raw-log-tab]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.rawLogTab === nextTab);
  });

  renderRawLogsTable(applyRawLogsFilters());
}

async function loadRawLogs() {
  const machineId = document.getElementById('rawLogsMachineId').value.trim();
  const limit = Number(document.getElementById('rawLogsLimit').value);
  const query = new URLSearchParams();
  const statusEl = document.getElementById('rawLogsStatus');

  if (machineId) {
    query.set('machine_id', machineId);
  }
  query.set('limit', String(limit));

  statusEl.textContent = 'Memuat raw logs...';

  try {
    const result = await callApi(`/api/webhook?${query.toString()}`, 'GET');

    if (!result.ok || result.data?.success === false) {
      rawLogsCache = [];
      document.getElementById('rawLogsUpdatedAt').textContent = '-';
      statusEl.textContent = result.data?.message || `Gagal memuat raw logs (HTTP ${result.status})`;
      renderRawLogsTable([]);
      return;
    }

    rawLogsCache = Array.isArray(result.data?.data) ? result.data.data : [];
    document.getElementById('rawLogsUpdatedAt').textContent = new Date().toLocaleString('id-ID');
    renderRawLogsTable(applyRawLogsFilters());
  } catch (error) {
    rawLogsCache = [];
    document.getElementById('rawLogsUpdatedAt').textContent = '-';
    statusEl.textContent = `Gagal memuat raw logs: ${error.message}`;
    renderRawLogsTable([]);
  }
}

function bindRawLogsTable() {
  const tbody = document.getElementById('rawLogsTableBody');
  tbody.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-log-id]');
    if (!row) {
      return;
    }

    selectedRawLogId = row.dataset.logId;
    renderRawLogsTable(applyRawLogsFilters());
  });

  document.querySelectorAll('[data-raw-log-tab]').forEach((button) => {
    button.addEventListener('click', () => setRawLogTab(button.dataset.rawLogTab));
  });
}

async function runSync(forceDryRun) {
  const requestId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  activeRequests.sync = requestId;
  const body = {
    source_cloud_id: document.getElementById('syncSourceCloudId').value.trim(),
    target_cloud_id: document.getElementById('syncTargetCloudId').value.trim(),
    trans_prefix: 'copy-user-ui',
    limit: Number(document.getElementById('syncLimit').value),
    concurrency: Number(document.getElementById('syncConcurrency').value),
    dry_run: forceDryRun === true ? true : parseBool(document.getElementById('syncDryRun').value),
    request_id: requestId,
  };

  const resultEl = document.getElementById('syncResult');
  resultEl.textContent = 'Sedang menjalankan sync...';
  const res = await callApi('/api/fingerspot/sync-employees', 'POST', body);
  resultEl.textContent = pretty({ status: res.status, ...res.data });
  activeRequests.sync = res.data?.request_id || null;
}

async function stopSync() {
  const resultEl = document.getElementById('syncResult');
  const response = await cancelRequest(activeRequests.sync);

  if (!response) {
    resultEl.textContent = 'Tidak ada sync request aktif';
    return;
  }

  resultEl.textContent = pretty({ status: response.status, ...response.data });
}

async function checkHealth() {
  const resultEl = document.getElementById('healthResult');
  resultEl.textContent = 'Checking...';
  const res = await callApi('/api/health', 'GET');
  resultEl.textContent = pretty({ status: res.status, ...res.data });
}

async function loadRuntimeConfig() {
  const runtimeRes = await callApi('/api/runtime/config', 'GET');
  document.getElementById('machineMapResult').textContent = pretty(runtimeRes.data?.data?.machine_map || {});
  document.getElementById('activeJobsResult').textContent = pretty({
    source: runtimeRes.data?.data?.sync_jobs_source || 'unknown',
    sync_jobs: runtimeRes.data?.data?.sync_jobs || [],
    cron_enabled: runtimeRes.data?.data?.cron_enabled || false,
    cron_interval_minutes: runtimeRes.data?.data?.cron_interval_minutes || 5,
  });

  const overrideRes = await callApi('/api/runtime/sync-jobs-override', 'GET');
  document.getElementById('syncJobsEditor').value = pretty(overrideRes.data?.data || []);
}

async function saveSyncJobsOverride() {
  const resultEl = document.getElementById('runtimeUpdateResult');
  const raw = document.getElementById('syncJobsEditor').value;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    resultEl.textContent = `JSON tidak valid: ${error.message}`;
    return;
  }

  if (!Array.isArray(parsed)) {
    resultEl.textContent = 'Format harus JSON array';
    return;
  }

  resultEl.textContent = 'Menyimpan override...';
  const res = await callApi('/api/runtime/sync-jobs-override', 'PUT', {
    sync_jobs: parsed,
  });
  resultEl.textContent = pretty({ status: res.status, ...res.data });
  await loadRuntimeConfig();
}

async function clearSyncJobsOverride() {
  document.getElementById('syncJobsEditor').value = '[]';
  await saveSyncJobsOverride();
}

function bindActions() {
  document.getElementById('saveDefaultsBtn').addEventListener('click', () => {
    applyDefaultsToForm();
    saveLocalDefaults();
  });

  document.getElementById('runBulkBtn').addEventListener('click', () => runBulk(false));
  document.getElementById('dryBulkBtn').addEventListener('click', () => runBulk(true));
  document.getElementById('stopBulkBtn').addEventListener('click', stopBulk);
  document.getElementById('loadEmployeesBtn').addEventListener('click', loadEmployees);
  document.getElementById('syncEmployeesBtn').addEventListener('click', () => runSync(false));
  document.getElementById('syncDryRunBtn').addEventListener('click', () => runSync(true));
  document.getElementById('stopSyncBtn').addEventListener('click', stopSync);
  document.getElementById('checkHealthBtn').addEventListener('click', checkHealth);
  document.getElementById('loadRawLogsBtn').addEventListener('click', loadRawLogs);
  document.getElementById('refreshRawLogsBtn').addEventListener('click', loadRawLogs);
  document.getElementById('rawLogsSearch').addEventListener('input', () => renderRawLogsTable(applyRawLogsFilters()));
  document.getElementById('rawLogsMachineId').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      loadRawLogs();
    }
  });
  document.getElementById('loadRuntimeConfigBtn').addEventListener('click', loadRuntimeConfig);
  document.getElementById('saveSyncJobsOverrideBtn').addEventListener('click', saveSyncJobsOverride);
  document.getElementById('clearSyncJobsOverrideBtn').addEventListener('click', clearSyncJobsOverride);
}

loadLocalDefaults();
bindActions();
bindRawLogsTable();
setRawLogTab('all');
checkHealth();
loadRuntimeConfig();
loadRawLogs();
rawLogsRefreshTimer = setInterval(loadRawLogs, 30000);
