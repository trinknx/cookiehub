# CookieHub — Personal Cookie Manager: Design Spec

Ngày: 2026-08-25
Trạng thái: Chờ user review

## 1. Mục tiêu

Webapp cá nhân (single-user) chạy trên VPS để quản lý nhiều cookie đăng nhập
(Netflix, Spotify, và các service khác) ở hai định dạng **Netscape** và
**header string**:

- Nhập (kể cả bulk), lưu trữ mã hóa, xuất/copy lại bất cứ lúc nào
- Check cookie LIVE / DIE kèm thông tin tài khoản (email, plan, hết hạn...)
- Check thủ công (từng cái / tất cả) + tự động định kỳ
- Mở rộng service mới bằng adapter file — không sửa core
- Hỗ trợ proxy (http/https/socks5) khi check
- Không public, không multi-user

### Non-goals (đù đẩy ra ngoài phạm vi)

- Multi-user / phân quyền / chia sẻ link công khai
- Headless browser check (Puppeteer) — HTTP check là đủ
- Thông báo Telegram/email khi cookie die
- Auto-refresh cookie / giải captcha

## 2. Kiến trúc

```
VPS
├── Caddy (reverse proxy, HTTPS tự động)
└── Node.js process (pm2 hoặc systemd)
    ├── Express API  ←→  React SPA (Vite build → dist/, Express phục vụ static)
    ├── Check Engine (fetch + proxy, queue concurrency)
    ├── Scheduler (node-cron)
    └── SQLite (better-sqlite3)
```

- 1 repo: `server/` (backend) + `client/` (React + Vite + Tailwind)
- Node.js ≥ 20 (dùng global fetch/undici)
- Deploy: build client → chạy server → Caddy TLS

## 3. Data model (SQLite)

Bảng `cookies`:

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| service_key | TEXT NOT NULL | khớp adapter `key` |
| label | TEXT | tên tự đặt, cho phép trùng |
| content_enc | BLOB NOT NULL | canonical cookies JSON, mã hóa AES-256-GCM |
| source_format | TEXT | `netscape` \| `header` — định dạng lúc import |
| status | TEXT NOT NULL DEFAULT 'unknown' | `unknown` \| `live` \| `die` |
| account_info | TEXT (JSON nullable) | email, plan, expiresAt, country... lấy được lần check gần nhất live |
| last_checked_at | INTEGER (ms epoch, nullable) | |
| notes | TEXT | |
| created_at / updated_at | INTEGER (ms epoch) | |

Bảng `check_logs`:

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | INTEGER PK | |
| cookie_id | INTEGER NOT NULL (FK cookies) | |
| status | TEXT NOT NULL | `live` \| `die` \| `error` |
| reason | TEXT | vì sao (redirect /login, 401, timeout...) |
| detail | TEXT (JSON nullable) | accountInfo raw |
| proxy_used | TEXT nullable | proxy đã dùng |
| duration_ms | INTEGER | |
| created_at | INTEGER (ms epoch) | |

`status = error` = lỗi hạ tầng (mạng/proxy/timeout), KHÔNG đổi `cookies.status`;
chỉ `live`/`die` từ adapter mới cập nhật `cookies.status`.

Bảng `settings` (key-value TEXT): `password_hash` (argon2id),
`auto_check_enabled` (`true|false`), `auto_check_interval_hours` (default `6`),
`proxy_global` (nullable).

Bảng `service_settings` (PK `service_key`): `proxy` (per-service override,
nullable), `disabled` (default `0`).

Bảng `sessions`: `token_hash` (sha256 của token, PK), `expires_at` (ms epoch),
`created_at`.

## 4. Service adapter (plugin)

Mỗi service = 1 file `server/services/adapters/<key>.js`. Registry quét thư mục
lúc boot. Thêm service = thả file + restart.

```js
module.exports = {
  key: 'netflix',
  name: 'Netflix',
  defaultDomain: 'netflix.com',
  /**
   * @param ctx {cookieHeader: string, cookies: CanonicalCookie[],
   *             fetch: (url, init) => Promise<Response>,  // đã gắn proxy + browser UA
   *             log: (msg: string) => void}
   * @returns {Promise<{status: 'live'|'die', reason: string,
   *                     accountInfo?: {email?, plan?, expiresAt?, country?, extra?}}>}
   */
  async check(ctx) { /* ... */ }
};
```

Quy ước adapter:

- `fetch` trong ctx đã có proxy resolved (per-service → global → direct),
  browser User-Agent, timeout 15s (AbortController)
- Adapter KHÔNG tự ném lỗi vì credential sai; trả `status: 'die'` + `reason`.
  Lỗi mạng/proxy → ném exception, engine ghi `error`
- `accountInfo` chỉ gồm những field lấy được, không bắt buộc đủ

Chiến lược check (implementation hint — verify bằng request thật khi code):

- **Netflix**: GET `https://www.netflix.com/browse` (redirect manual). 3xx →
  `/login` = die. 200 = live; sau đó GET `/account` parse plan + ngày thanh
  toán kế tiếp, email/region từ trang tài khoản hoặc endpoint nội bộ nếu lấy
  được authURL
- **Spotify**: thử JSON endpoint account (VD `/api/account/v1/...`), 401/redirect
  = die; fallback GET `/account/overview` parse email/plan/ngày hết hạn

## 5. Cookie formats

Canonical internal (lưu trong `content_enc` sau khi mã hóa):

```json
[{"domain":".netflix.com","path":"/","secure":true,"httpOnly":false,
  "expiration": 1790000000000, "name":"...", "value":"..."}]
```

### Nhận diện (per chunk)

1. Tách bulk bằng dòng trống
2. Netscape nếu ≥1 dòng có ≥6 field tab-separated (chấp nhận prefix
   `#HttpOnly_` trên field domain); parse các cột: domain, includeSubdomains,
   path, secure, expiration (epoch giây), name, value. Bỏ dòng comment `#`
   (trừ `#HttpOnly_`)
3. Header string nếu khớp dạng `name=value(; name=value)*` (cho phép nhiều
   dòng, normalize về 1 dòng)
4. JSON array (Cookie-Editor): chunk là mảng JSON, mỗi phần tử một object
   `{name, value, domain, path, secure, httpOnly, expirationDate (epoch
   giây)...}`; auto-detect khi ≥1 phần tử là object có `name` string. Khi tách
   bulk, các JSON array (in nhiều dòng) được bóc theo cặp ngoặc `[]` cân bằng
   trước — bỏ qua text rác bao quanh (dòng tiêu đề, separator trong file
   seller); dấu `]` nằm trong chuỗi giá trị JSON không làm lệch việc tách. Phần
   text còn lại mới áp dụng tách theo dòng trống
5. Không khớp → reject chunk, báo lỗi per-item

### Chuyển đổi

- **Xuất header**: join `name=value` bằng `; `
- **Xuất Netscape**: render từng canonical cookie thành 7 cột tab-separated;
  cookie không có domain (từ header import) dùng `defaultDomain` của service;
  không có expiration → epoch xa (năm 2038+)
- Import header string → canonical: domain = `defaultDomain`, path `/`,
  secure = true (default an toàn cho service https)

### Giới hạn

Mỗi chunk ≤ 100KB; bulk import ≤ 500 chunks/lần.

## 6. API

Tất cả trừ `/api/auth/*` đều cần session hợp lệ. Mutating request phải kèm
header `X-Requested-With: XMLHttpRequest`. Response lỗi thống nhất:
`{"error": {"code": "...", "message": "..."}}`.

```
POST  /api/auth/setup    {password}          # chỉ khi chưa có password (lần chạy đầu)
POST  /api/auth/login    {password} → set cookie session (7 ngày)
POST  /api/auth/logout
GET   /api/auth/session  → {authenticated, needsSetup}

GET   /api/cookies?service=&status=&q=&page=  # KHÔNG trả content giải mã
POST  /api/cookies       {service, content, label?, notes?}
                           # content nhận bulk → {created:[...], failed:[{index, error}]}
PATCH /api/cookies/:id   {label?, notes?, service?}
DELETE /api/cookies/:id
POST  /api/cookies/:id/check
POST  /api/cookies/check-all                  # {service?} — filter theo service nếu có
GET   /api/cookies/check-all                  # trạng thái job: {running, pending, done, failed}
GET   /api/cookies/:id/logs?limit=
GET   /api/cookies/:id/export?format=header|netscape → {content}

GET   /api/services       → [{key, name, disabled, cookieCount}]
PATCH /api/services/:key  {proxy?, disabled?}   # proxy: string|null, null = kế thừa proxy global

GET   /api/settings       → {autoCheckEnabled, autoCheckIntervalHours, proxyGlobal}
PUT   /api/settings       {autoCheckEnabled?, autoCheckIntervalHours?, proxyGlobal?}
POST  /api/settings/password {currentPassword, newPassword}
```

## 7. Frontend

React + Vite + Tailwind, 3 route:

- `/login` — password; lần đầu hiện form setup nếu `needsSetup`
- `/` — dashboard:
  - Bảng: label, service, status badge (live xanh / die đỏ / unknown xám) +
    last checked, account info (email, plan, expiry), actions: Check / Copy
    header / Copy Netscape / Edit / Delete
  - Toolbar: search, filter service + status, nút Add, nút Check All (có
    progress + kết quả tổng hợp)
  - Click row → drawer chi tiết: notes, lịch sử check_logs
  - Bulk import modal: chọn service, paste, preview số chunk detected +
    format từng chunk, kết quả per-item sau import
- `/settings` — proxy global, interval auto-check + enable, đổi password;
    per-service: proxy override, disable

Copy dùng Clipboard API + toast xác nhận.

## 8. Bảo mật

- Password: argon2id hash trong `settings.password_hash`
- Login rate-limit: 5 lần sai/IP → 429 lock 15 phút (in-memory)
- Session: token 256-bit random, lưu sha256 hash trong `sessions`, cookie
  `sid` httpOnly + sameSite=lax + secure (qua HTTPS), TTL 7 ngày
- Cookie content: AES-256-GCM at-rest. Key `ENCRYPTION_KEY` (base64 32 bytes)
  trong `.env`; thiếu lúc boot → tự sinh, ghi `.env`, log cảnh báo
- CSRF: sameSite=lax + yêu cầu `X-Requested-With` trên mọi mutating request
- `GET /api/cookies` không trả content giải mã; chỉ qua endpoint export riêng
- HTTPS qua Caddy (deployment docs)

## 9. Check engine & scheduler

- Queue global concurrency 3; min gap 1000ms giữa 2 request cùng service
- Proxy resolution per check: service proxy → global proxy → direct.
  `http://`/`https://` → undici ProxyAgent; `socks5://` → custom undici
  connector (socks package). Proxy lỗi → check_logs status `error`
- Timeout 15s/request (AbortController)
- Check-all: đưa tất cả cookie (trừ service disabled) vào queue, trả về
  ngay `{queued: n}`. KHÔNG websocket (YAGNI): UI poll `GET /api/cookies/check-all`
  mỗi 2s để lấy tiến độ, song song refresh `GET /api/cookies`
- Scheduler: node-cron tính từ `auto_check_interval_hours` (1–168h, default 6);
  đổi setting → reschedule; boot → reschedule nếu enabled; ghi log mỗi run
- Một cookie check tay đang chạy → request check thứ 2 trả 409

## 10. Error handling

- Lỗi API: 400 (validate), 401 (chưa login), 403 (CSRF header thiếu),
  404, 409 (đang check), 423 (service disabled), 429 (rate limit), 500
- Check `error` không đổi status cookie; UI hiện lỗi gần nhất từ logs
- Import bulk: chunk lỗi không chặn chunk hợp lệ; response liệt kê đủ
- Server crash-safe: SQLite WAL mode; mã hóa per-row (iv riêng) nên lỗi 1 row
  không ảnh hưởng row khác

## 11. Testing (Vitest)

Unit:

- Format: detect (netscape/header/rác), parse netscape (kể `#HttpOnly_`,
  comment lines), parse header, convert 2 chiều, bulk split, giới hạn kích thước
- Crypto: AES-GCM round-trip, sai key → lỗi rõ ràng
- Auth: middleware, setup một lần, rate-limit, CSRF header check
- Adapters: live/die/reason với fixture HTML/JSON + mocked fetch (gồm case
  redirect login, 401, network throw → error)
- Scheduler: interval → cron pattern, disable/enable

API (supertest + in-memory SQLite):

- Auth flow, cookies CRUD + bulk import (thành công + lỗi trộn lẫn), check
  (mock engine), settings, phân trang/filter

Smoke thủ công khi deploy: check cookie Netflix + Spotify thật, proxy thật.

## 12. Deployment

- `.env`: `PORT` (default 3000), `ENCRYPTION_KEY`
- Build: `npm run build` (client) → `npm start` (server)
- Process: pm2 hoặc systemd unit (docs trong README)
- Caddyfile mẫu: reverse proxy + TLS tự động
- README: các bước từ clone → chạy

## 13. Thứ tự triển khai dự kiến

1. Scaffold (server + client + tooling)
2. Crypto + DB layer + migrations
3. Auth (setup/login/session/rate-limit)
4. Cookie import (parse/detect) + CRUD + export
5. Adapter framework + Netflix + Spotify adapter
6. Check engine (queue/proxy) + manual check
7. Scheduler + settings
8. UI: login → dashboard → settings
9. Tests tích hợp + README + deploy docs
