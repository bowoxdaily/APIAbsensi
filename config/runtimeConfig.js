function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return String(value).toLowerCase() === 'true';
}

function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function getMachineMapFromIndexedEnv() {
  const map = {};
  const cloudIdEntries = Object.entries(process.env).filter(([key, val]) => {
    return /^MACHINE_\d+_CLOUD_ID$/.test(key) && val;
  });

  for (const [key, cloudId] of cloudIdEntries) {
    const index = key.match(/^MACHINE_(\d+)_CLOUD_ID$/)?.[1];
    const nameKey = `MACHINE_${index}_NAME`;
    const machineName = process.env[nameKey] || `Machine ${index}`;
    map[String(cloudId)] = machineName;
  }

  return map;
}

function getMachineMap() {
  const raw = parseJson(process.env.MACHINE_MAP_JSON, null);
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw)) {
      const mapFromArray = {};
      for (const item of raw) {
        if (!item || !item.cloud_id) {
          continue;
        }
        mapFromArray[String(item.cloud_id)] = item.name || null;
      }
      if (Object.keys(mapFromArray).length) {
        return mapFromArray;
      }
    } else {
      const objectMap = {};
      for (const [cloudId, name] of Object.entries(raw)) {
        objectMap[String(cloudId)] = name || null;
      }
      if (Object.keys(objectMap).length) {
        return objectMap;
      }
    }
  }

  const envMap = getMachineMapFromIndexedEnv();
  if (Object.keys(envMap).length) {
    return envMap;
  }

  return {
    GQ5179635: 'VIVO ASSEMBLING 1',
    GQ5778665: 'VIVO ASSEMBLING 2',
  };
}

function normalizeSyncJob(job, idx) {
  if (!job || typeof job !== 'object') {
    return null;
  }

  const sourceCloudId = job.source_cloud_id || job.sourceCloudId;
  const targetCloudId = job.target_cloud_id || job.targetCloudId;

  if (!sourceCloudId || !targetCloudId) {
    return null;
  }

  return {
    source_cloud_id: String(sourceCloudId),
    target_cloud_id: String(targetCloudId),
    trans_prefix: job.trans_prefix || job.transPrefix || `sync-cron-${idx + 1}`,
    start_pin: job.start_pin ?? job.startPin ?? job.pin_start ?? job.pinStart ?? null,
    end_pin: job.end_pin ?? job.endPin ?? job.pin_end ?? job.pinEnd ?? null,
    limit: Math.max(Number(job.limit || 1000), 1),
    concurrency: Math.min(Math.max(Number(job.concurrency || 3), 1), 10),
    dry_run: toBoolean(job.dry_run ?? job.dryRun, false),
  };
}

function getSyncJobs() {
  const rawJobs = parseJson(process.env.SYNC_JOBS_JSON, null);
  if (Array.isArray(rawJobs)) {
    const jobs = rawJobs
      .map((job, idx) => normalizeSyncJob(job, idx))
      .filter(Boolean);

    if (jobs.length) {
      return jobs;
    }
  }

  const sourceCloudId = process.env.SYNC_SOURCE_CLOUD_ID || process.env.MACHINE_1_CLOUD_ID || '';
  const targetCloudId = process.env.SYNC_TARGET_CLOUD_ID || process.env.MACHINE_2_CLOUD_ID || '';

  if (!sourceCloudId || !targetCloudId) {
    return [];
  }

  return [
    {
      source_cloud_id: sourceCloudId,
      target_cloud_id: targetCloudId,
      trans_prefix: process.env.SYNC_TRANS_PREFIX || 'sync-cron',
      start_pin: process.env.SYNC_START_PIN || null,
      end_pin: process.env.SYNC_END_PIN || null,
      limit: Math.max(Number(process.env.SYNC_LIMIT || 1000), 1),
      concurrency: Math.min(Math.max(Number(process.env.SYNC_CONCURRENCY || 3), 1), 10),
      dry_run: toBoolean(process.env.SYNC_DRY_RUN, false),
    },
  ];
}

module.exports = {
  getMachineMap,
  getSyncJobs,
  normalizeSyncJob,
  toBoolean,
};
