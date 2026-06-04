/**
 * Kunci unik scan — dipakai konsisten di Supabase, webhook, cron, dan dedup HRIS.
 */
function buildSourceKey(cloudId, row) {
  const pin = row?.pin ?? '';
  const scanDate = row?.scan_date ?? row?.scan ?? '';
  const verify = row?.verify ?? '';
  const statusScan = row?.status_scan ?? '';
  return `${cloudId}|${pin}|${scanDate}|${verify}|${statusScan}`;
}

module.exports = { buildSourceKey };
