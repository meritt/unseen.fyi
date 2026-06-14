# Unseen — сервер

Один Bun-процесс. Состояние в RAM. Бэкенд = relay для непрозрачных блобов + раздача статики SPA. Никаких баз данных, никакого постоянного состояния. Перезапуск = все комнаты теряются.

## Стек

- **Среда выполнения**: Bun 1.3.14.
- **Зависимости рабочей сборки**: ноль. Вспомогательные крипто-функции и wire-кодек — общий workspace `shared/` с клиентом.
- **TypeScript**: `@typescript/native-preview` (tsgo), проверка типов через `tsgo --noEmit`.
- **HTTP + WebSocket**: `Bun.serve` напрямую, без фреймворков.

## Архитектура

Один процесс, всё состояние в RAM. Логические модули:

- **Транспорт.** `Bun.serve` обслуживает HTTP и WebSocket-upgrade на одном порту. Страница ошибок разработчика отключена; необработанное исключение даёт generic 500 с security-заголовками. WebSocket ограничен `MAX_WIRE_BYTES` на фрейм, без permessage-deflate (сжимать зашифрованные блобы бессмысленно) и без встроенных пингов рантайма — keepalive ведётся явным интервалом (см. «Keepalive»).
- **Wire-обработчики.** Маршрутизация HELLO по intent, транзакционная доставка ACK и PEER_JOINED, побайтовый форвард RELAY и HANDSHAKE. Проверка Origin на upgrade и извлечение клиентского IP из доверенного proxy-заголовка с нормализацией IPv4-mapped IPv6.
- **Реестр комнат.** In-memory отображение `roomId → Room`; два слота (initiator / joiner) и состояние `WAITING` / `PAIRED` / `HALF_OPEN`.
- **Сборщик очистки.** Периодический проход удаляет просроченные `WAITING`-комнаты и истёкшие по льготному периоду `HALF_OPEN`-комнаты.
- **Keepalive.** Периодический серверный PING каждому открытому сокету — держит NAT-маппинг тёплым.
- **Ограничение темпа.** Per-IP token bucket на каждое действие плюс per-connection bucket для RELAY.
- **Раздача статики.** SPA-оболочки, ассеты по allowlist, `/healthz`; единый набор security-заголовков на любой ответ.
- **Метрики.** Опциональный отдельный экземпляр на приватном порту, Prometheus-формат.
- **Логирование и конфигурация.** Структурированный логгер с двойным allowlist в `stdout` / `stderr`; конфигурация через переменные окружения.

## Конфигурация (env vars)

| Переменная                                     | По умолчанию                   | Назначение                                                                                         |
| ---------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `UNSEEN_HOST`                                  | `0.0.0.0`                      | хост привязки                                                                                      |
| `UNSEEN_PORT`                                  | `3001`                         | порт привязки (1–65535)                                                                            |
| `UNSEEN_PROXY_HEADER`                          | —                              | имя заголовка с IP клиента (например, `x-forwarded-for`); если не задан, используется адрес сокета |
| `UNSEEN_ALLOWED_ORIGINS`                       | — (same-origin)                | CSV-список точных совпадений разрешённых Origin для WS upgrade                                     |
| `UNSEEN_CLIENT_DIST_DIR`                       | каталог рабочей сборки клиента | абсолютный путь к статике рабочей сборки                                                           |
| `UNSEEN_GRACE_MS`                              | 300 000                        | льготный период для HALF_OPEN-комнаты                                                              |
| `UNSEEN_SWEEP_MS`                              | 30 000                         | период работы планировщика очистки                                                                 |
| `UNSEEN_WS_KEEPALIVE_MS`                       | 20 000                         | интервал серверных WebSocket keepalive-пингов                                                      |
| `UNSEEN_RL_CONNECT_LIMIT` / `_REFILL_PER_SEC`  | 100 / 100/60                   | per-IP token bucket для connect                                                                    |
| `UNSEEN_RL_NEWROOM_LIMIT` / `_REFILL_PER_SEC`  | 10 / 10/60                     | per-IP для intent=create                                                                           |
| `UNSEEN_RL_JOINROOM_LIMIT` / `_REFILL_PER_SEC` | 30 / 30/60                     | per-IP для intent=join/resume                                                                      |
| `UNSEEN_RL_HEALTH_LIMIT` / `_REFILL_PER_SEC`   | 60 / 60/60                     | per-IP для `/healthz`                                                                              |
| `UNSEEN_RL_RELAY_LIMIT` / `_REFILL_PER_SEC`    | 2000 / 200                     | per-connection RELAY token bucket (окно по умолчанию 10 с)                                         |
| `UNSEEN_METRICS_ENABLED`                       | `false`                        | `true` запускает сервер `/metrics`                                                                 |
| `UNSEEN_METRICS_USER` / `_PASS`                | — (обязательны, если включён)  | учётные данные Basic auth                                                                          |
| `UNSEEN_METRICS_BIND`                          | `127.0.0.1`                    | хост привязки metrics-сервера                                                                      |
| `UNSEEN_METRICS_PORT`                          | `9101`                         | порт привязки metrics-сервера                                                                      |

`UNSEEN_METRICS_ENABLED=true` без USER/PASS → конфигурация отвергается при запуске (немедленный отказ).

## HTTP routing

```
GET /            → SPA shell (index.html, предрендеренные тексты лендинга)
GET /r402        → SPA shell (r402.html, предрендеренный каркас чата)
GET /healthz     → "ok" (rate-limited per-IP)
GET /assets/...  → static allowlist (.js, .css, .woff2, .svg, .png, .webp, .avif, .ico)
GET /favicon.svg → static
GET /robots.txt  → static
GET /sitemap.xml → static
GET /og-image.png → static (Open Graph / Twitter card image)
GET /ws          → WebSocket upgrade
*                → 404
не-GET/HEAD      → 405 (Allow: GET, HEAD)
```

### Раздача статики

Две SPA-оболочки (`/` → лендинг, `/r402` → каркас чата) и статический allowlist: ассеты в `/assets/` ограничены набором расширений (`js`, `css`, `woff2`, `svg`, `png`, `webp`, `avif`, `ico`), плюс точечно `/favicon.svg`, `/robots.txt`, `/sitemap.xml`, `/og-image.png`. Всё, что вне allowlist, — 404.

Защита от обхода каталога: путь декодируется, резолвится и проверяется на принадлежность корню статики. Allowlist не пропускает символ `%`, поэтому percent-encoded `..` не проходит ни сопоставление, ни проверку резолвинга.

**Cache-Control:**

- SPA-оболочки: `no-cache` (принудительный условный GET) + слабый ETag (SHA-256 от сырых байт, считается один раз на файл и кэшируется на процесс). Совпадение `If-None-Match` → `304 Not Modified` без тела.
- Хешированные ресурсы: `public, max-age=31536000, immutable` (деплой меняет URL, браузер перезапрашивает).

**Сжатие на лету** для текстовых ответов (`js`, `css`, `svg`, `html`): согласуется по `Accept-Encoding` — Brotli приоритетно (лучший коэффициент на тексте), Gzip как запасной. Каждый ассет сжимается один раз и кэшируется на процесс; хешированные имена в рабочей сборке гарантируют сброс кеша. На сжатом ответе ставится `Vary: accept-encoding`.

### Security headers (на каждом ответе)

Набор ниже штампуется на **любой** ответ — SPA, ассет, 404, `/healthz`, 403, 426, 405, generic 500 — а не только на файловые. `Cache-Control` задаётся индивидуально (immutable для хешированных ассетов, no-cache для оболочки, no-store для остального). `connect-src 'self'` покрывает same-origin WebSocket (`wss://<origin>/ws`) в CSP3-браузерах и закрывает эксфильтрацию на произвольный хост.

```
Content-Security-Policy: default-src 'none';
                         script-src 'self';
                         style-src 'self';
                         img-src 'self';
                         worker-src 'self';
                         connect-src 'self';
                         frame-ancestors 'none';
                         base-uri 'none';
                         form-action 'none';
                         require-trusted-types-for 'script';
                         trusted-types lit-html unseen-worker-url

Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Permissions-Policy: camera=(), microphone=(), geolocation=(),
                    clipboard-write=(self), clipboard-read=(),
                    idle-detection=(), display-capture=(),
                    screen-wake-lock=()
```

`worker-src 'self'` строго — никаких `blob:`/`data:`. XSS-атакующий не может через `new Worker(URL.createObjectURL(...))` обойти SRI на worker entry points.

`require-trusted-types-for 'script'` переводит DOM XSS-синки (`innerHTML`, `eval`, URL воркеров) в режим Trusted Types. Allowlist — ровно две политики: `lit-html` (создаёт Lit при загрузке модуля) и `unseen-worker-url` (same-origin `TrustedScriptURL` для точек входа воркеров).

`style-src 'self'` без `'unsafe-inline'` — клиент использует light DOM + global CSS файлы, не inline `<style>` или CSSOM adopted stylesheets.

### SRI

На этапе сборки встраивается SHA-384 integrity для каждого ресурса (`<script integrity>`, `<link rel="stylesheet" integrity>`, `<link rel="modulepreload" integrity>` для общих чанков и воркеров). Только в рабочей сборке; dev-сервер отдаёт без SRI.

## Gate WebSocket upgrade

Upgrade проходит две проверки до резервирования слота:

1. **Origin.** Без `UNSEEN_ALLOWED_ORIGINS` принимается только same-origin (Origin запроса совпадает с origin сервера); с заданным списком — точное совпадение с одним из разрешённых. Отсутствует или не совпадает → 403 Forbidden.
2. **Клиентский IP.** Если задан `UNSEEN_PROXY_HEADER` — берётся последний токен заголовка, но только если это корректный IP; подделанный или неразборчивый токен отбрасывается с откатом на адрес сокета. Без заголовка используется адрес сокета. IPv4-mapped IPv6 (`::ffff:x.x.x.x`) нормализуется в IPv4; пустой или неразборчивый адрес сводится к общему bucket `"unknown"`.

На успешном upgrade соединение учитывается счётчиком подключений.

Per-WS состояние: фаза соединения (`PENDING_HELLO` / `WAITING_FOR_PEER` / `PAIRED`), `roomId`, роль, IP, hello-таймер и per-connection RELAY-bucket.

## Wire-обработчики

### Open

`connect`-лимит per-IP (превышение → `RATE_LIMITED` + close). Затем взводится `HELLO_DEADLINE_MS` (5 s): если HELLO не пришёл, соединение закрывается с `HELLO_TIMEOUT` (slowloris-guard).

### Message — HELLO

Принимается только в `PENDING_HELLO`; `protocolVersion` ≠ `PROTOCOL_VERSION` → `UNSUPPORTED_VERSION`. Маршрутизация по intent:

- `create`: проходит `newRoom`-лимит per-IP; на уже существующей комнате → `ROOM_ALREADY_EXISTS` (штатно — клиент повторяет как `join`); иначе комната создаётся, инициатору шлётся ACK.
- `join` / `resume`: проходят `joinRoom`-лимит; слот занимается, оставшемуся peer шлётся PEER_JOINED. Семантика по состоянию комнаты — `02-protocol.md §Восстановление сессии`.

ACK и PEER_JOINED доставляются транзакционно: при сбое отправки комната откатывается и обе стороны закрываются, чтобы не осталось рассогласованного состояния (один peer считает себя спаренным, другой нет).

### Message — HANDSHAKE / RELAY (форвард)

Принимается только в `PAIRED`:

- `byteLength > MAX_WIRE_BYTES` → `MESSAGE_TOO_LARGE`.
- HANDSHAKE: длина ≠ `HANDSHAKE_FRAME_LENGTH` (61) → `INVALID_PAYLOAD`; более одного HANDSHAKE на соединение → `BAD_STATE`. HANDSHAKE одноразовый (resume / rekey идут через RELAY), поэтому cap = 1 не даёт спаренному peer флудить, минуя RELAY-bucket.
- RELAY: per-connection token bucket; исчерпан → `RATE_LIMITED`.
- буфер peer выше `PEER_BUFFER_CAP_BYTES` (8 MiB) → обе стороны закрываются (peer overflow).
- кадр пересылается **байт-в-байт, без re-encode**; сбой отправки → обе стороны закрываются.

### Close

Уход одной стороны → `HALF_OPEN`: оставшийся peer получает PEER_DISCONNECTED (ориентировочный льготный период 5 мин), сборщик очистки позже шлёт PEER_LEFT. Уход обеих → комната удаляется сразу (восстановление через серверный token не поддерживается).

В состоянии `HALF_OPEN` фрейм от оставшегося peer (отправленный до разрыва, но дошедший до сервера уже после) отбрасывается молча: комната остаётся пригодной для resume, а дисконнект не превращается в `ROOM_NOT_FOUND` при возврате второй стороны. HANDSHAKE в `HALF_OPEN` при этом списывает токен RELAY-bucket — одиночный отставший фрейм проходит молча, но флуд исчерпывает bucket и закрывает соединение `RATE_LIMITED`.

## Room registry

`Map<roomId, Room>` в памяти. Комната хранит два слота (initiator / joiner), состояние (`WAITING` / `PAIRED` / `HALF_OPEN`) и метки создания и последней активности (для cleanup).

Переходы:

- создание комнаты → `WAITING`.
- второй peer занял слот → `PAIRED` (если только initiator — остаётся `WAITING`; свободных слотов нет → отказ).
- уход одной стороны → `HALF_OPEN`; уход обеих → комната удаляется.

Снимок по состояниям (`waiting` / `active` / `halfOpen`) формирует значения metrics gauges.

## Сборщик очистки

Периодический проход (`SWEEP_INTERVAL_MS`):

- `WAITING` старше `INITIATOR_WAIT_TIMEOUT_MS` (5 мин) → инициатор закрывается, комната удаляется.
- `HALF_OPEN` без активности дольше льготного периода (`GRACE_PERIOD_MS`, 5 мин) → оставшемуся peer шлётся PEER_LEFT, соединение закрывается, комната удаляется.

## Keepalive

Простаивающее WS-соединение не несёт фреймов, и NAT/прокси на пути вырезают «тихие» TCP-соединения по своему idle-таймауту; в RAM-режиме это молча завершает сессию (auto-reconnect только в PRF, см. `02-protocol.md`). Поэтому каждые `UNSEEN_WS_KEEPALIVE_MS` (по умолчанию 20 000 мс) сервер шлёт RFC 6455 PING каждому открытому сокету — обоим слотам всех комнат (`WAITING` / `PAIRED` / `HALF_OPEN`). Браузер автоматически отвечает PONG; трафик в обе стороны держит маппинг тёплым. PING — control-frame, не RELAY-фрейм, поэтому байтовая идентичность пересылки не затрагивается. Интервал выбран заметно ниже самых коротких idle-таймаутов NAT/прокси (~30 с).

## Rate limiting

### Per-IP token bucket

Независимые bucket на каждую пару «IP + действие»; дефолтные ёмкости и темпы пополнения — в таблице env-vars выше (connect, newRoom, joinRoom, health). Неактивные bucket удаляются по TTL 10 минут периодическим проходом.

IPv6-адреса сводятся к префиксу /64 перед поиском bucket: /64 выдаётся одному абоненту, поэтому ротация адресов внутри подсети не плодит записи. Каждое отображение ограничено 50 000 записей: вставка поверх лимита вытесняет самую старую (по порядку вставки), так что новые честные клиенты не блокируются. Вытесненный и созданный заново bucket стартует с полным запасом токенов — приемлемая best-effort деградация при намеренной ротации IP.

Значения по умолчанию рассчитаны на небольшое самостоятельное развёртывание.

### Per-connection RELAY bucket

Отдельный bucket на каждое соединение для RELAY-фреймов (по умолчанию ёмкость 2000, пополнение 200/с → 2000 фреймов за 10 с в устойчивом режиме). Лимит подобран под всплеск чанков при передаче файла: ~150 fps × 8 KiB ≈ 1.2 MiB/s в устойчивом режиме с ~33% запаса. Без него передача 5 MiB упиралась бы в rate-limit на десятой секунде.

## Logger

`process.stdout.write` для info, `process.stderr.write` для warn/error. Один JSON-объект на строку, с завершающим `\n`.

### Двойной allowlist sanitizer

Разрешён фиксированный набор ключей: `level`, `time`, `msg`, `port`, `errorClass`, `errorCode`, `rateLimitBucket`, `activeRooms`, `waitingRooms`, `totalConnections`. Всё остальное отсекается при сериализации:

- Ключ вне набора — молча отбрасывается.
- Значения-перечисления (`errorClass`, `errorCode`, `rateLimitBucket`) проходят только при совпадении с ALL-CAPS-шаблоном `^[A-Z][A-Z0-9_]{0,63}$`; иначе отбрасываются.
- Поле `msg` обязано совпасть с `^[A-Za-z0-9 .,:_-]{1,200}$`; иначе заменяется на `log_msg_rejected` (запись всё равно пишется, чтобы не терять контекст).
- Числовые значения пропускаются как есть.

Байты payload, IP, `roomId` и содержимое сообщений физически не входят в allowlist ключей — они не могут оказаться в stdout даже при ошибке вызывающего кода.

### Aggregate emitter

Каждые 60 секунд пишется запись `aggregate_metrics` с полями `{activeRooms, waitingRooms, totalConnections}`. Дополняет Prometheus scrape (если включён) или даёт минимальную наблюдаемость там, где есть внешний сборщик логов без Prometheus.

## Metrics

`/metrics` HTTP-сервер — **опциональный**, на отдельном порту (по умолчанию `127.0.0.1:9101`), отдельный экземпляр `Bun.serve`. Не на публичном основном порту.

```
GET 127.0.0.1:9101/metrics
Authorization: Basic <base64(user:pass)>
```

- Auth через constant-time сравнение байтов учётных данных.
- 401 + `WWW-Authenticate: Basic realm="metrics"` без верных учётных данных.
- 404 на любом пути, кроме `/metrics`.
- Все ответы с `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` (gauge не кэшируются на scrape-пути).
- Страница ошибок разработчика отключена; необработанное исключение → generic 500.

### Prometheus exposition

```
# HELP unseen_active_rooms Currently active (paired) rooms.
# TYPE unseen_active_rooms gauge
unseen_active_rooms <count>

# HELP unseen_waiting_rooms Rooms waiting for a peer to join.
# TYPE unseen_waiting_rooms gauge
unseen_waiting_rooms <count>

# HELP unseen_half_open_rooms Rooms in the post-disconnect grace window.
# TYPE unseen_half_open_rooms gauge
unseen_half_open_rooms <count>

# HELP unseen_connections_total Total WebSocket upgrades since start.
# TYPE unseen_connections_total counter
unseen_connections_total <count>

# HELP unseen_relays_total RELAY frames forwarded since start.
# TYPE unseen_relays_total counter
unseen_relays_total <count>

# HELP unseen_rate_limit_rejections_total Requests rejected by the per-IP rate limiter.
# TYPE unseen_rate_limit_rejections_total counter
unseen_rate_limit_rejections_total <count>
```

Все counters монотонные, снимок возвращает обычные числа без идентификаторов сессий.
