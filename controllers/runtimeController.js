const {
  getRuntimeConfigSummary,
  writeSyncJobsOverride,
  readSyncJobsOverride,
} = require('../config/runtimeStore');

const API_TOKEN = process.env.API_TOKEN || '';

function isAuthorized(req) {
  if (!API_TOKEN) {
    return true;
  }

  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const headerToken = req.headers['x-api-token'];

  return bearerToken === API_TOKEN || headerToken === API_TOKEN;
}

async function getRuntimeConfig(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized',
    });
  }

  const data = await getRuntimeConfigSummary();
  return res.json({
    success: true,
    data,
  });
}

async function updateSyncJobs(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized',
    });
  }

  const syncJobs = req.body?.sync_jobs;
  if (!Array.isArray(syncJobs)) {
    return res.status(400).json({
      success: false,
      message: 'sync_jobs harus berupa array',
    });
  }

  const savedJobs = await writeSyncJobsOverride(syncJobs);
  return res.json({
    success: true,
    message: savedJobs.length
      ? 'Override sync jobs berhasil disimpan'
      : 'Override dikosongkan. Scheduler akan fallback ke env.',
    count: savedJobs.length,
    data: savedJobs,
  });
}

async function getSyncJobsOverride(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized',
    });
  }

  const jobs = await readSyncJobsOverride();
  return res.json({
    success: true,
    count: jobs.length,
    data: jobs,
  });
}

module.exports = {
  getRuntimeConfig,
  updateSyncJobs,
  getSyncJobsOverride,
};
