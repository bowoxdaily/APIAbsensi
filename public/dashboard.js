function pretty(data) {
  return JSON.stringify(data, null, 2);
}

function parseBool(value) {
  return String(value) === 'true';
}

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
  const body = {
    cloud_id: document.getElementById('bulkCloudId').value.trim(),
    start_pin: Number(document.getElementById('bulkStartPin').value),
    end_pin: Number(document.getElementById('bulkEndPin').value),
    pin_width: Number(document.getElementById('bulkPinWidth').value),
    trans_prefix: 'userinfo-bulk-ui',
    concurrency: Number(document.getElementById('bulkConcurrency').value),
    dry_run: forceDryRun === true ? true : parseBool(document.getElementById('bulkDryRun').value),
  };

  const resultEl = document.getElementById('bulkResult');
  resultEl.textContent = 'Sedang kirim request bulk...';
  const res = await callApi('/api/fingerspot/get-userinfo-bulk', 'POST', body);
  resultEl.textContent = pretty({ status: res.status, ...res.data });
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

async function runSync(forceDryRun) {
  const body = {
    source_cloud_id: document.getElementById('syncSourceCloudId').value.trim(),
    target_cloud_id: document.getElementById('syncTargetCloudId').value.trim(),
    trans_prefix: 'copy-user-ui',
    limit: Number(document.getElementById('syncLimit').value),
    concurrency: Number(document.getElementById('syncConcurrency').value),
    dry_run: forceDryRun === true ? true : parseBool(document.getElementById('syncDryRun').value),
  };

  const resultEl = document.getElementById('syncResult');
  resultEl.textContent = 'Sedang menjalankan sync...';
  const res = await callApi('/api/fingerspot/sync-employees', 'POST', body);
  resultEl.textContent = pretty({ status: res.status, ...res.data });
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
  document.getElementById('loadEmployeesBtn').addEventListener('click', loadEmployees);
  document.getElementById('syncEmployeesBtn').addEventListener('click', () => runSync(false));
  document.getElementById('syncDryRunBtn').addEventListener('click', () => runSync(true));
  document.getElementById('checkHealthBtn').addEventListener('click', checkHealth);
  document.getElementById('loadRuntimeConfigBtn').addEventListener('click', loadRuntimeConfig);
  document.getElementById('saveSyncJobsOverrideBtn').addEventListener('click', saveSyncJobsOverride);
  document.getElementById('clearSyncJobsOverrideBtn').addEventListener('click', clearSyncJobsOverride);
}

loadLocalDefaults();
bindActions();
checkHealth();
loadRuntimeConfig();
