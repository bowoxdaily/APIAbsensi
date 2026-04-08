require('dotenv').config();

const fs = require('fs/promises');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const apiRoutes = require('./routes/api');
const { runEmployeeSync } = require('./controllers/userSyncController');
const { getActiveSyncJobs } = require('./config/runtimeStore');

const app = express();
const port = process.env.PORT || 3000;

async function ensureRuntimeFiles() {
  const logsDir = path.join(__dirname, 'logs');
  await fs.mkdir(logsDir, { recursive: true });

  const fileDefaults = [
    { fileName: 'data.txt', content: '' },
    { fileName: 'attlog.txt', content: '' },
    { fileName: 'userinfo.txt', content: '' },
    { fileName: 'other.txt', content: '' },
    { fileName: 'sync-state.json', content: JSON.stringify({ machines: {} }, null, 2) },
    { fileName: 'sync-jobs.override.json', content: JSON.stringify({ sync_jobs: [] }, null, 2) },
  ];

  for (const item of fileDefaults) {
    const fullPath = path.join(logsDir, item.fileName);
    try {
      await fs.access(fullPath);
    } catch (error) {
      await fs.writeFile(fullPath, item.content, 'utf8');
    }
  }
}

ensureRuntimeFiles().catch((error) => {
  console.error(`[bootstrap] gagal menyiapkan file runtime: ${error.message}`);
});

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'API webhook absensi aktif',
    dashboard: '/dashboard',
  });
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.use('/api', apiRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint tidak ditemukan',
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    success: false,
    message: 'Terjadi kesalahan server',
  });
});

app.listen(port, () => {
  console.log(`Server berjalan di port ${port}`);

  const enableSyncCron = String(process.env.ENABLE_SYNC_CRON || 'false').toLowerCase() === 'true';
  if (!enableSyncCron) {
    return;
  }

  const intervalMinutes = Math.max(Number(process.env.SYNC_CRON_INTERVAL_MINUTES || 5), 1);

  let isSyncRunning = false;
  const runSyncJob = async () => {
    if (isSyncRunning) {
      console.log('[sync-cron] Skip: job sebelumnya masih berjalan');
      return;
    }

    isSyncRunning = true;
    const startedAt = new Date().toISOString();
    try {
      const activeJobs = await getActiveSyncJobs();
      if (!activeJobs.jobs.length) {
        console.log('[sync-cron] Skip: tidak ada sync job aktif');
        return;
      }

      for (const job of activeJobs.jobs) {
        const result = await runEmployeeSync(job);
        console.log(
          `[sync-cron] ${startedAt} [${activeJobs.source}] ${job.source_cloud_id}->${job.target_cloud_id} status=${result.statusCode} success=${result.payload?.success} total=${result.payload?.total || result.payload?.count || 0}`
        );
      }
    } catch (error) {
      console.error(`[sync-cron] ${startedAt} gagal: ${error.message}`);
    } finally {
      isSyncRunning = false;
    }
  };

  console.log(`[sync-cron] Aktif tiap ${intervalMinutes} menit`);
  runSyncJob();
  setInterval(runSyncJob, intervalMinutes * 60 * 1000);
});
