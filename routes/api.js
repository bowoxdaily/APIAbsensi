const express = require('express');
const {
  storeWebhook,
  getWebhookLogs,
  getWebhookLogById,
  getSyncFeed,
  markMachineSynced,
  getSyncState,
  healthCheck,
} = require('../controllers/webhookController');
const { getAttlog, getCombinedAttlog } = require('../controllers/attlogController');
const {
  callGetUserInfo,
  callGetUserInfoBulk,
  callGetAttlog,
  callGetAttlogBulk,
} = require('../controllers/fingerspotController');
const {
  getEmployees,
  syncEmployeesToMachine,
} = require('../controllers/userSyncController');
const {
  getRuntimeConfig,
  updateSyncJobs,
  getSyncJobsOverride,
} = require('../controllers/runtimeController');
const { cancelSession, getSession } = require('../config/requestRegistry');

const router = express.Router();

function requireApiAuth(req, res, next) {
  const apiToken = process.env.API_TOKEN || '';
  if (!apiToken) {
    return next();
  }

  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const headerToken = req.headers['x-api-token'];

  if (bearerToken === apiToken || headerToken === apiToken) {
    return next();
  }

  return res.status(401).json({ success: false, message: 'Unauthorized' });
}

router.get('/health', healthCheck);
router.post('/webhook', storeWebhook);
router.post('/webhook/userinfo', storeWebhook);
router.get('/webhook', requireApiAuth, getWebhookLogs);
router.get('/webhook/:id', requireApiAuth, getWebhookLogById);
router.get('/sync', requireApiAuth, getSyncFeed);
router.get('/sync/state', requireApiAuth, getSyncState);
router.post('/sync/ack', requireApiAuth, markMachineSynced);
router.get('/attlog', getAttlog);
router.get('/attlog/combined', getCombinedAttlog);
router.post('/fingerspot/get-userinfo', requireApiAuth, callGetUserInfo);
router.post('/fingerspot/get-attlog', requireApiAuth, callGetAttlog);
router.post('/fingerspot/get-attlog-bulk', requireApiAuth, callGetAttlogBulk);
router.get('/employees', requireApiAuth, getEmployees);
router.post('/fingerspot/get-userinfo-bulk', requireApiAuth, callGetUserInfoBulk);
router.post('/fingerspot/sync-employees', requireApiAuth, syncEmployeesToMachine);
router.get('/runtime/config', getRuntimeConfig);
router.get('/runtime/sync-jobs-override', getSyncJobsOverride);
router.put('/runtime/sync-jobs-override', updateSyncJobs);
router.get('/requests/:requestId', requireApiAuth, (req, res) => {
  const session = getSession(req.params.requestId);
  if (!session) {
    return res.status(404).json({ success: false, message: 'Request tidak ditemukan' });
  }

  return res.json({ success: true, data: session });
});
router.post('/requests/:requestId/cancel', requireApiAuth, (req, res) => {
  const session = cancelSession(req.params.requestId);
  if (!session) {
    return res.status(404).json({ success: false, message: 'Request tidak ditemukan' });
  }

  return res.json({ success: true, message: 'Request dibatalkan', data: session });
});

module.exports = router;
