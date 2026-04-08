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

module.exports = router;
