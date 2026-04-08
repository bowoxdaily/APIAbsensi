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

router.get('/health', healthCheck);
router.post('/webhook', storeWebhook);
router.post('/webhook/userinfo', storeWebhook);
router.get('/webhook', getWebhookLogs);
router.get('/webhook/:id', getWebhookLogById);
router.get('/sync', getSyncFeed);
router.get('/sync/state', getSyncState);
router.post('/sync/ack', markMachineSynced);
router.get('/attlog', getAttlog);
router.get('/attlog/combined', getCombinedAttlog);
router.post('/fingerspot/get-userinfo', callGetUserInfo);
router.post('/fingerspot/get-attlog', callGetAttlog);
router.post('/fingerspot/get-attlog-bulk', callGetAttlogBulk);
router.get('/employees', getEmployees);
router.post('/fingerspot/get-userinfo-bulk', callGetUserInfoBulk);
router.post('/fingerspot/sync-employees', syncEmployeesToMachine);
router.get('/runtime/config', getRuntimeConfig);
router.get('/runtime/sync-jobs-override', getSyncJobsOverride);
router.put('/runtime/sync-jobs-override', updateSyncJobs);
router.get('/requests/:requestId', (req, res) => {
  const session = getSession(req.params.requestId);
  if (!session) {
    return res.status(404).json({ success: false, message: 'Request tidak ditemukan' });
  }

  return res.json({ success: true, data: session });
});
router.post('/requests/:requestId/cancel', (req, res) => {
  const session = cancelSession(req.params.requestId);
  if (!session) {
    return res.status(404).json({ success: false, message: 'Request tidak ditemukan' });
  }

  return res.json({ success: true, message: 'Request dibatalkan', data: session });
});

module.exports = router;
