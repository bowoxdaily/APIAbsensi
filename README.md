# Project Absensi Webhook API

API ini menerima webhook absensi dari Fingerspot dan menyimpan setiap payload ke `logs/data.txt` sebagai arsip umum, lalu memisahkan data scan dan userinfo ke file khusus.

Untuk kasus 2 mesin, backend ini berperan sebagai pusat sinkron. Setiap event dari mesin A dan mesin B disimpan dengan `machineId`, lalu Laravel bisa mengambil feed perubahan dari endpoint sync untuk mendorong data ke sistem lain atau menyimpan status cursor terakhir.

Struktur file log sekarang:

- `logs/attlog.txt` untuk scan absensi (`type: attlog`)
- `logs/userinfo.txt` untuk `get_userinfo` dan `set_userinfo`
- `logs/other.txt` untuk event lain
- `logs/data.txt` tetap menjadi arsip semua event

## Instalasi

```bash
npm install
npm start
```

## Environment

Isi `.env` sesuai kebutuhan:

```env
PORT=3000
API_TOKEN=change-this-token
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=absensi
```

Jika `API_TOKEN` diisi, request ke endpoint webhook harus membawa token yang sama lewat header `Authorization: Bearer ...` atau `x-api-token`.

Khusus endpoint callback webhook (`/api/webhook` dan `/api/webhook/userinfo`) tidak lagi menggunakan `API_TOKEN` agar callback Fingerspot tidak tertolak. Jika ingin diamankan, isi `WEBHOOK_TOKEN` di `.env`, lalu kirim lewat `x-webhook-token`, `Authorization: Bearer ...`, atau query `?webhook_token=...`.

Kalau Fingerspot mengirim field identitas mesin, gunakan salah satu: `machine_id`, `machineId`, `device_id`, `deviceId`, atau header `x-machine-id`.

Default mapping awal yang dipakai adalah:

- `GQ5179635` -> `VIVO ASSEMBLING 1`
- `GQ5778665` -> `VIVO ASSEMBLING 2`

Untuk penambahan mesin ke depannya, Anda bisa:

- Tetap pakai pola `MACHINE_1_*`, `MACHINE_2_*`, `MACHINE_3_*`, dst.
- Atau pakai `MACHINE_MAP_JSON` di `.env` agar semua mesin didefinisikan dalam satu variabel.

Contoh `MACHINE_MAP_JSON`:

```env
MACHINE_MAP_JSON={"GQ5179635":"VIVO ASSEMBLING 1","GQ5778665":"VIVO ASSEMBLING 2","GQ1234567":"VIVO ASSEMBLING 3"}
```

Jika `MACHINE_MAP_JSON` diisi, mapping ini akan diprioritaskan.

## Scheduler Sync Untuk Banyak Mesin

Cron sync sudah bisa dijalankan untuk banyak pasangan mesin sekaligus.

1. Aktifkan scheduler:

```env
ENABLE_SYNC_CRON=true
SYNC_CRON_INTERVAL_MINUTES=5
```

2. Isi pasangan sync via `SYNC_JOBS_JSON`:

```env
SYNC_JOBS_JSON=[
  {"source_cloud_id":"GQ5179635","target_cloud_id":"GQ5778665","trans_prefix":"sync-1-2","limit":1000,"concurrency":3,"dry_run":false},
  {"source_cloud_id":"GQ1234567","target_cloud_id":"GQ5778665","trans_prefix":"sync-3-2","limit":1000,"concurrency":3,"dry_run":false}
]
```

Jika `SYNC_JOBS_JSON` kosong, sistem akan fallback ke mode lama (`SYNC_SOURCE_CLOUD_ID` dan `SYNC_TARGET_CLOUD_ID`).

## Endpoint

- `GET /api/health` - cek service aktif
- `POST /api/webhook` - simpan webhook
- `GET /api/webhook` - baca semua webhook terbaru dari arsip campuran
- `GET /api/webhook/:id` - baca webhook berdasarkan ID
- `GET /api/sync` - ambil data dari mesin lain untuk disinkronkan
- `GET /api/sync/state` - lihat cursor sinkron tiap mesin
- `POST /api/sync/ack` - simpan cursor terakhir per mesin
- `GET /api/attlog` - baca scan attlog dari `logs/attlog.txt`
- `POST /api/fingerspot/get-attlog` - proxy request ke API Fingerspot `get_attlog`
- `POST /api/fingerspot/get-attlog-bulk` - ambil attlog rentang panjang (max 60 hari) dengan auto-split 2 hari
- `POST /api/fingerspot/get-userinfo` - kirim perintah `get_userinfo` ke Fingerspot
- `POST /api/fingerspot/get-userinfo-bulk` - kirim `get_userinfo` untuk banyak PIN sekaligus
- `POST /api/webhook/userinfo` - endpoint callback webhook userinfo dari Fingerspot
- `GET /api/employees` - ambil daftar user unik dari data webhook userinfo
- `POST /api/fingerspot/sync-employees` - kirim user dari mesin sumber ke mesin tujuan (misal mesin B)
- `GET /api/runtime/config` - lihat machine map dan sync jobs aktif (source env/override)
- `GET /api/runtime/sync-jobs-override` - lihat override sync jobs dari file runtime
- `PUT /api/runtime/sync-jobs-override` - simpan override sync jobs (langsung dipakai cron tanpa restart)

## Ambil Semua Karyawan Dari Mesin A

Karena `get_userinfo` harus dipanggil per PIN, gunakan endpoint bulk ini untuk mengirim banyak PIN sekaligus.

- Method: `POST`
- URL: `http://localhost:3000/api/fingerspot/get-userinfo-bulk`
- Headers:
  - `Content-Type: application/json`
- Body JSON contoh:

```json
{
  "cloud_id": "GQ5179635",
  "start_pin": 1,
  "end_pin": 200,
  "pin_width": 4,
  "trans_prefix": "userinfo-bulk",
  "concurrency": 5,
  "dry_run": true
}
```

Catatan:

- `start_pin` dan `end_pin` adalah range PIN yang mau dicoba.
- `pin_width` dipakai supaya PIN jadi `0001`, `0013`, dst.
- `concurrency` lebih tinggi akan lebih cepat, tapi jangan terlalu tinggi kalau mesin mulai lambat atau sering balas `ERROR_NO_ID`.
- Mulai dari `dry_run: true` dulu untuk cek daftar PIN yang akan dikirim.
- Setelah itu ubah ke `dry_run: false` agar permintaan benar-benar dikirim ke Fingerspot.
- Semua data yang kembali dari webhook akan tetap tersimpan di [logs/data.txt](logs/data.txt).

## Get Semua Karyawan Dari Webhook

Endpoint ini mengambil semua user yang sudah pernah masuk lewat callback `get_userinfo` atau `set_userinfo`.

- Method: `GET`
- URL: `http://localhost:3000/api/employees?source_cloud_id=GQ5179635`

Jika `source_cloud_id` tidak diisi, semua mesin akan digabung.

## Copy Karyawan Ke Mesin B

Contoh copy semua user dari mesin A (`GQ5179635`) ke mesin B (`GQ5778665`):

- Method: `POST`
- URL: `http://localhost:3000/api/fingerspot/sync-employees`
- Headers:
  - `
  
```json
{
  "source_cloud_id": "GQ5179635",
  "target_cloud_id": "GQ5778665",
  "trans_prefix": "copy-user",
  "dry_run": false
}
```

Catatan:

- `dry_run: true` untuk cek data user tanpa mengirim ke mesin tujuan.
- Jika hasil `count` 0, berarti data userinfo dari mesin sumber belum ada di webhook log. Jalankan `get_userinfo` per PIN dulu agar masuk ke log.

## Test Get Userinfo Via Postman

- Method: `POST`
- URL: `http://localhost:3000/api/fingerspot/get-userinfo`
- Headers:
  - `Content-Type: application/json`
- Body JSON contoh:

```json
{
    "trans_id": "userinfo-001",
    "cloud_id": "GQ5179635",
    "pin": "1"
}
```

Catatan:

- Response dari endpoint ini biasanya berupa ACK/perintah diterima.
- Detail userinfo akan dikirim oleh mesin ke webhook.
- Set webhook URL di panel Fingerspot ke: `https://domain-anda/api/webhook/userinfo`

## Test Get Attlog Via Postman

1. Isi `.env` terlebih dahulu:

```env
FINGERSPOT_API_TOKEN=isi_token_sdk_online_anda
FINGERSPOT_BASE_URL=https://developer.fingerspot.io/api
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=isi_service_role_key
SUPABASE_TABLE=attlogs
```

2. Buat tabel Supabase (SQL Editor):

```sql
create table if not exists public.attlogs (
  id bigserial primary key,
  source_key text not null unique,
  cloud_id text not null,
  trans_id text,
  pin text,
  scan_date text,
  verify int,
  status_scan int,
  photo_url text,
  requested_start_date date,
  requested_end_date date,
  raw_payload jsonb,
  fetched_at timestamptz default now(),
  created_at timestamptz default now()
);
```

3. Jalankan server:

```bash
npm start
```

4. Kirim request dari Postman ke server lokal Anda:

- Method: `POST`
- URL: `http://localhost:3000/api/fingerspot/get-attlog`
- Headers:
  - `Content-Type: application/json`
- Body JSON contoh mesin 1:

```json
{
  "trans_id": "attlog-001",
  "cloud_id": "GQ5179635",
  "start_date": "2026-04-01",
  "end_date": "2026-04-02"
}
```

Body JSON contoh mesin 2:

```json
{
  "trans_id": "attlog-002",
  "cloud_id": "GQ5778665",
  "start_date": "2026-04-01",
  "end_date": "2026-04-02"
}
```

Endpoint lokal ini akan meneruskan request ke Fingerspot dan mengembalikan response dari server Fingerspot di field `upstream`.
Setiap data attlog yang diterima juga otomatis di-upsert ke Supabase, dan scan webhook juga disimpan ke `logs/attlog.txt`.
Kalau `start_date` dan `end_date` tidak diisi, backend otomatis memakai rentang hari ini dan kemarin.

Kalau mau ambil scan gabungan dari semua mesin terdaftar, gunakan `GET /api/attlog/combined`.

## Test Get Attlog Bulk (Auto Split 2 Hari)

Gunakan endpoint ini jika ingin tarik data lebih panjang tanpa kirim berkali-kali secara manual.

- Method: `POST`
- URL: `http://localhost:3000/api/fingerspot/get-attlog-bulk`
- Headers:
  - `Content-Type: application/json`
- Body JSON contoh:

```json
{
  "trans_id": "attlog-bulk-001",
  "cloud_id": "GQ5179635",
  "start_date": "2026-03-01",
  "end_date": "2026-04-07"
}
```

Catatan:

- Range maksimal 60 hari per request bulk.
- Sistem akan otomatis memecah request menjadi beberapa chunk (maksimal 2 hari/chunk).
- Response berisi ringkasan `chunks` dan gabungan data di `data`.

## Contoh Payload Webhook

```json
{
  "employee_id": "A001",
  "name": "Budi",
  "status": "check-in",
  "time": "2026-04-07T08:00:00+07:00"
}
```

## Contoh Laravel

```php
use Illuminate\Support\Facades\Http;

$response = Http::withHeaders([
    'x-api-token' => env('ABSENSI_WEBHOOK_TOKEN'),
])->post(env('ABSENSI_WEBHOOK_URL') . '/api/webhook', [
    'employee_id' => 'A001',
    'name' => 'Budi',
    'status' => 'check-in',
    'time' => now()->toIso8601String(),
]);

$data = $response->json();
```

Contoh ambil data dari mesin lain untuk sinkron:

```php
$response = Http::withHeaders([
  'x-api-token' => env('ABSENSI_WEBHOOK_TOKEN'),
])->get(env('ABSENSI_WEBHOOK_URL') . '/api/sync', [
  'machine_id' => 'MESIN_1',
  'since' => '2026-04-07T00:00:00.000Z',
]);

$records = $response->json('data');
```

Kalau ingin menyimpan posisi terakhir sinkron:

```php
$response = Http::withHeaders([
  'x-api-token' => env('ABSENSI_WEBHOOK_TOKEN'),
])->post(env('ABSENSI_WEBHOOK_URL') . '/api/sync/ack', [
  'machine_id' => 'MESIN_1',
  'cursor' => now()->toISOString(),
]);
```

## Catatan

- Data disimpan ke `logs/data.txt` sebagai JSONL agar mudah diproses ulang.
- Setiap record juga menyimpan `machineId` dan `machineName`, jadi data dari dua mesin bisa dipisah atau disinkronkan berdasarkan Cloud ID.
- Jika nanti ingin pindah ke MySQL atau PostgreSQL, file `config/db.js` sudah disiapkan sebagai titik awal.
