const fs = require('fs/promises');
const path = require('path');
const { getSyncJobs, normalizeSyncJob, getMachineMap, toBoolean } = require('./runtimeConfig');

const syncJobsOverridePath = path.join(process.cwd(), 'logs', 'sync-jobs.override.json');

async function ensureOverrideFile() {
  await fs.mkdir(path.dirname(syncJobsOverridePath), { recursive: true });
  try {
    await fs.access(syncJobsOverridePath);
  } catch (error) {
    await fs.writeFile(syncJobsOverridePath, JSON.stringify({ sync_jobs: [] }, null, 2), 'utf8');
  }
}

async function readSyncJobsOverride() {
  await ensureOverrideFile();
  try {
    const raw = await fs.readFile(syncJobsOverridePath, 'utf8');
    const parsed = raw ? JSON.parse(raw) : { sync_jobs: [] };
    return Array.isArray(parsed.sync_jobs) ? parsed.sync_jobs : [];
  } catch (error) {
    return [];
  }
}

async function writeSyncJobsOverride(rawJobs = []) {
  await ensureOverrideFile();
  const jobs = (Array.isArray(rawJobs) ? rawJobs : [])
    .map((job, idx) => normalizeSyncJob(job, idx))
    .filter(Boolean);

  const payload = {
    sync_jobs: jobs,
    updated_at: new Date().toISOString(),
  };

  await fs.writeFile(syncJobsOverridePath, JSON.stringify(payload, null, 2), 'utf8');
  return jobs;
}

async function getActiveSyncJobs() {
  const overrideJobs = await readSyncJobsOverride();
  const normalizedOverride = overrideJobs
    .map((job, idx) => normalizeSyncJob(job, idx))
    .filter(Boolean);

  if (normalizedOverride.length) {
    return {
      source: 'override',
      jobs: normalizedOverride,
    };
  }

  return {
    source: 'env',
    jobs: getSyncJobs(),
  };
}

async function getRuntimeConfigSummary() {
  const activeJobs = await getActiveSyncJobs();

  return {
    cron_enabled: toBoolean(process.env.ENABLE_SYNC_CRON, false),
    cron_interval_minutes: Math.max(Number(process.env.SYNC_CRON_INTERVAL_MINUTES || 5), 1),
    machine_map: getMachineMap(),
    sync_jobs_source: activeJobs.source,
    sync_jobs: activeJobs.jobs,
  };
}

module.exports = {
  getRuntimeConfigSummary,
  writeSyncJobsOverride,
  readSyncJobsOverride,
  getActiveSyncJobs,
};
