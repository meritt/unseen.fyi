# Unseen — сервер

Один процесс `Bun.serve`: relay непрозрачных блобов плюс раздача статики SPA. Всё состояние в RAM, у рабочей сборки нет зависимостей, крипто-функции и wire-кодек берутся из общего workspace `shared/`. Ни базы данных, ни постоянного состояния: перезапуск теряет все комнаты.

## Модули

- **Транспорт.** HTTP и WebSocket-upgrade на одном порту. Страница ошибок разработчика отключена, необработанное исключение даёт generic 500 с security-заголовками. Фрейм WebSocket ограничен `MAX_WIRE_BYTES`, permessage-deflate выключен (сжимать шифротекст бессмысленно), пинги рантайма выключены (`idleTimeout: 0`) — keepalive ведётся явным интервалом. Остановка закрывает основной и metrics-сервер с дедлайном 5 с.
- **Wire-обработчики.** Маршрутизация HELLO по intent, транзакционная доставка ACK и PEER_JOINED, побайтовый форвард HANDSHAKE и RELAY.
- **Реестр комнат.** In-memory `roomId → Room`: два слота (initiator / joiner), состояние `WAITING` / `PAIRED` / `HALF_OPEN`, метки создания и последней активности.
- **Сборщик очистки.** Периодический проход удаляет просроченные `WAITING`-комнаты и истёкшие по льготному периоду `HALF_OPEN`-комнаты, попутно чистит неактивные rate-limit bucket.
- **Keepalive.** Периодический PING каждому открытому сокету всех комнат.
- **Ограничение темпа.** Per-IP token bucket на действие плюс per-connection bucket для RELAY.
- **Потолок соединений.** `UNSEEN_MAX_CONNECTIONS` ограничивает число одновременно открытых WebSocket; сверх потолка соединение получает `OVER_CAPACITY` и закрывается. Счётчик учитывает только принятые соединения: отклонённое по темпу или по потолку слот не занимает. Комната всегда держит хотя бы одно соединение, поэтому потолок ограничивает и число комнат.
- **Раздача статики.** Две SPA-оболочки, ассеты по allowlist, `/healthz`; единый набор security-заголовков на любом ответе.
- **Реакция на давление памяти.** По сигналу ОС (`memoryPressure`) выполняется внеочередной проход очистки и закрытие простаивающих keep-alive соединений; запросы в полёте и веб-сокеты живых комнат не затрагиваются. Реакция срабатывает не чаще раза в секунду: Linux PSI повторяет уведомление в каждом окне мониторинга, пока давление держится.
- **Метрики.** Опциональный отдельный экземпляр `Bun.serve` на приватном порту, Prometheus-формат.
- **Логирование и конфигурация.** Структурированный логгер с двойным allowlist в `stdout` / `stderr`, конфигурация через переменные окружения.

## Конфигурация

Все значения читаются один раз при старте; неподходящее значение — немедленный отказ запуска, а не тихий откат к умолчанию.

| Переменная                                     | По умолчанию                   | Назначение                                                           |
| ---------------------------------------------- | ------------------------------ | -------------------------------------------------------------------- |
| `UNSEEN_HOST`                                  | `0.0.0.0`                      | хост привязки                                                        |
| `UNSEEN_PORT`                                  | `3001`                         | порт привязки, целое в [1, 65535]                                    |
| `UNSEEN_PROXY_HEADER`                          | — (адрес сокета)               | имя заголовка с IP клиента, например `x-forwarded-for`               |
| `UNSEEN_ALLOWED_ORIGINS`                       | — (same-origin)                | CSV точных Origin, допустимых при WS upgrade                         |
| `UNSEEN_CLIENT_DIST_DIR`                       | `client/dist`                  | абсолютный путь к статике рабочей сборки                             |
| `UNSEEN_GRACE_MS`                              | `300000`                       | льготный период `HALF_OPEN`-комнаты                                  |
| `UNSEEN_SWEEP_MS`                              | `30000`                        | период планировщика очистки                                          |
| `UNSEEN_WS_KEEPALIVE_MS`                       | `20000`                        | интервал серверных WebSocket-пингов                                  |
| `UNSEEN_MAX_CONNECTIONS`                       | `256`                          | потолок открытых WebSocket; худший случай очереди ≈ значение × 8 MiB |
| `UNSEEN_RL_CONNECT_LIMIT` / `_REFILL_PER_SEC`  | `100` / `100/60`               | per-IP bucket на открытие соединения                                 |
| `UNSEEN_RL_NEWROOM_LIMIT` / `_REFILL_PER_SEC`  | `10` / `10/60`                 | per-IP bucket на `intent=create`                                     |
| `UNSEEN_RL_JOINROOM_LIMIT` / `_REFILL_PER_SEC` | `30` / `30/60`                 | per-IP bucket на `intent=join` и `intent=resume`                     |
| `UNSEEN_RL_HEALTH_LIMIT` / `_REFILL_PER_SEC`   | `60` / `1`                     | per-IP bucket на `/healthz`                                          |
| `UNSEEN_RL_RELAY_LIMIT` / `_REFILL_PER_SEC`    | `2000` / `200`                 | per-connection bucket на RELAY                                       |
| `UNSEEN_METRICS_ENABLED`                       | `false`                        | `true` поднимает сервер `/metrics`                                   |
| `UNSEEN_METRICS_USER` / `_PASS`                | — (обязательны при включённых) | учётные данные Basic auth                                            |
| `UNSEEN_METRICS_BIND`                          | `127.0.0.1`                    | хост привязки metrics-сервера                                        |
| `UNSEEN_METRICS_PORT`                          | `9101`                         | порт привязки metrics-сервера                                        |

`UNSEEN_METRICS_ENABLED=true` без USER и PASS — конфигурация отвергается при запуске.

## HTTP

```
GET /             → index.html (оболочка лендинга)
GET /r402         → r402.html  (предрендеренный каркас чата)
GET /healthz      → "ok", per-IP лимит, при исчерпании 429
GET /assets/...   → статика по allowlist расширений
GET /favicon.svg /robots.txt /sitemap.xml /og-image.png → статика
GET /ws           → WebSocket upgrade
*                 → 404
не-GET/HEAD       → 405 (Allow: GET, HEAD)
```

Ассеты в `/assets/` ограничены набором расширений (`js`, `css`, `woff2`, `svg`, `png`, `webp`, `avif`, `ico`), остальные четыре файла разрешены точечно. Всё вне allowlist — 404.

Защита от обхода каталога: путь декодируется, резолвится и проверяется на принадлежность корню статики. Allowlist не пропускает символ `%`, поэтому percent-encoded `..` не проходит ни сопоставление, ни проверку резолвинга.

**Кэширование.** Любой отдаваемый файл получает слабый ETag (SHA-256 сырых байт, считается один раз на файл и кэшируется на процесс); совпадение `If-None-Match` → `304` без тела. `Cache-Control`: `no-cache` для SPA-оболочек (принудительный условный GET), `public, max-age=31536000, immutable` для хешированных ассетов, `no-store` для всего остального.

**Сжатие на лету** для `js`, `css`, `svg`, `html`: согласуется по `Accept-Encoding`, Brotli приоритетно, Gzip запасной. Каждый ассет сжимается один раз и кэшируется на процесс; на сжатом ответе ставится `Vary: accept-encoding`.

### Security headers

Набор штампуется на **любой** ответ — оболочку, ассет, 404, `/healthz`, 403, 405, 426, generic 500.

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
Permissions-Policy: camera=(), microphone=(), geolocation=(),
                    clipboard-write=(self), clipboard-read=(),
                    idle-detection=(), display-capture=(),
                    screen-wake-lock=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`connect-src 'self'` покрывает same-origin WebSocket (`wss://<origin>/ws`) и закрывает эксфильтрацию на произвольный хост. `worker-src 'self'` строго, без `blob:` и `data:`: XSS-атакующий не обойдёт SRI на точках входа воркеров через `new Worker(URL.createObjectURL(...))`. `require-trusted-types-for 'script'` переводит DOM XSS-синки в режим Trusted Types с ровно двумя политиками: `lit-html` (создаёт Lit при загрузке модуля) и `unseen-worker-url` (same-origin `TrustedScriptURL` для воркеров). `style-src 'self'` без `'unsafe-inline'` — клиент использует light DOM и глобальные CSS-файлы, без inline `<style>` и adopted stylesheets.

SHA-384 SRI для скриптов, стилей и modulepreload встраивается на этапе сборки только в рабочей сборке; dev-сервер отдаёт без SRI.

## WebSocket

### Upgrade

Две проверки до резервирования слота:

1. **Origin.** Без `UNSEEN_ALLOWED_ORIGINS` принимается только same-origin; со списком — точное совпадение. Отсутствует или не совпал → 403.
2. **Клиентский IP.** С `UNSEEN_PROXY_HEADER` берётся последний токен заголовка и только если это корректный IP, иначе откат на адрес сокета. IPv4-mapped IPv6 (`::ffff:x.x.x.x`) нормализуется в IPv4; пустой или отсутствующий адрес сводится к общему bucket `unknown`.

Отказ `Bun.serve` в апгрейде даёт 426. Успешный апгрейд учитывается счётчиком подключений. Per-WS состояние: фаза (`PENDING_HELLO` / `WAITING_FOR_PEER` / `PAIRED`), `roomId`, роль, IP, hello-таймер, RELAY-bucket и счётчик форвардов HANDSHAKE.

### Open

Сначала per-IP лимит `connect` (исчерпан → `RATE_LIMITED` + close), затем потолок соединений (`OVER_CAPACITY` + close). Принятое соединение взводит `HELLO_DEADLINE_MS` (5 с): без HELLO соединение закрывается с `HELLO_TIMEOUT` (slowloris-guard).

### HELLO

Принимается только в `PENDING_HELLO`, иначе `BAD_STATE`; `protocolVersion` ≠ `PROTOCOL_VERSION` → `UNSUPPORTED_VERSION`. Дальше по intent:

- `create` проходит лимит `newRoom`; существующая комната → `ROOM_ALREADY_EXISTS` (штатный случай, клиент повторяет как `join`), иначе комната создаётся и инициатору уходит ACK.
- `join` и `resume` проходят лимит `joinRoom`; `join` в `HALF_OPEN` → `ROOM_FULL` (слот держится за resume), нет свободного слота → `ROOM_FULL`, иначе слот занимается, новому клиенту уходит ACK, оставшемуся peer — PEER_JOINED. Семантика по состоянию комнаты — `02-protocol.md §Восстановление сессии`.

ACK и PEER_JOINED доставляются транзакционно: при сбое отправки комната откатывается и обе стороны закрываются, чтобы не осталось рассогласованного состояния.

### HANDSHAKE и RELAY

Принимаются только в `PAIRED`:

- `byteLength > MAX_WIRE_BYTES` → `MESSAGE_TOO_LARGE`.
- HANDSHAKE длиной ≠ `HANDSHAKE_FRAME_LENGTH` (61) → `INVALID_PAYLOAD`; более одного HANDSHAKE на соединение → `BAD_STATE`. HANDSHAKE одноразовый (resume и rekey идут через RELAY), поэтому cap = 1 не даёт спаренному peer флудить мимо RELAY-bucket.
- RELAY списывает токен per-connection bucket; исчерпан → `RATE_LIMITED`.
- Буфер peer выше `PEER_BUFFER_CAP_BYTES` (8 MiB) → обе стороны закрываются.
- Кадр пересылается **байт-в-байт, без re-encode**; сбой отправки → обе стороны закрываются.

В `HALF_OPEN` кадр от оставшегося peer (отправленный до разрыва, дошедший после) отбрасывается молча: комната остаётся пригодной для resume, а дисконнект не превращается в `ROOM_NOT_FOUND` при возврате второй стороны. HANDSHAKE в `HALF_OPEN` при этом списывает токен RELAY-bucket — одиночный отставший фрейм проходит молча, флуд исчерпывает bucket и закрывает соединение `RATE_LIMITED`.

### Close

Уход одной стороны переводит комнату в `HALF_OPEN`, оставшийся peer получает PEER_DISCONNECTED с фиксированной подсказкой 5 мин (значение подсказки не следует за `UNSEEN_GRACE_MS`); PEER_LEFT позже шлёт сборщик очистки. Уход обеих — комната удаляется сразу, восстановление через серверный токен не поддерживается.

## Очистка и keepalive

Периодический проход (`UNSEEN_SWEEP_MS`):

- `WAITING` старше `INITIATOR_WAIT_TIMEOUT_MS` (5 мин) → инициатор закрывается, комната удаляется.
- `HALF_OPEN` без активности дольше льготного периода → оставшемуся peer шлётся PEER_LEFT, соединение закрывается, комната удаляется.

Простаивающее WS-соединение не несёт фреймов, и NAT или прокси на пути вырезают «тихие» TCP-соединения по своему idle-таймауту; в RAM-режиме это молча завершает сессию (auto-reconnect есть только в PRF). Поэтому каждые `UNSEEN_WS_KEEPALIVE_MS` сервер шлёт RFC 6455 PING обоим слотам всех комнат, браузер автоматически отвечает PONG. PING — control-frame, байтовая идентичность пересылки не затрагивается. Интервал выбран заметно ниже самых коротких idle-таймаутов NAT (~30 с).

## Rate limiting

**Per-IP.** Независимые bucket на каждую пару «IP + действие»; ёмкости и темпы — в таблице конфигурации. Неактивные bucket удаляются по TTL 10 минут. IPv6 сводится к префиксу /64: он выдаётся одному абоненту, поэтому ротация адресов внутри подсети не плодит записи. Каждое отображение ограничено 50 000 записей, вставка поверх лимита вытесняет самую старую по порядку вставки, так что новые честные клиенты не блокируются; вытесненный и созданный заново bucket стартует с полным запасом токенов — приемлемая best-effort деградация при намеренной ротации IP. Значения по умолчанию рассчитаны на небольшое самостоятельное развёртывание.

**Per-connection RELAY.** Отдельный bucket на соединение: 2000 токенов, 200/с — 2000 фреймов за 10 с в устойчивом режиме. Подобран под всплеск чанков при передаче файла (~150 fps × 8 KiB ≈ 1.2 MiB/s, запас ~33%); без него передача 5 MiB упиралась бы в лимит на десятой секунде.

## Логи

`process.stdout.write` для info, `process.stderr.write` для warn и error, один JSON-объект на строку.

Двойной allowlist санитайзера: разрешены ровно ключи `level`, `time`, `msg`, `port`, `errorClass`, `errorCode`, `rateLimitBucket`, `activeRooms`, `waitingRooms`, `totalConnections`. Ключ вне набора молча отбрасывается. Значения-перечисления (`errorClass`, `errorCode`, `rateLimitBucket`) проходят только при совпадении с `^[A-Z][A-Z0-9_]{0,63}$`. Поле `msg` обязано совпасть с `^[A-Za-z0-9 .,:_-]{1,200}$`, иначе заменяется на `log_msg_rejected` (запись всё равно пишется). Числа проходят как есть.

Байты payload, IP, `roomId` и содержимое сообщений физически не входят в allowlist — они не могут оказаться в stdout даже при ошибке вызывающего кода.

Каждые 60 с пишется запись `aggregate_metrics` с полями `activeRooms`, `waitingRooms`, `totalConnections`: она дополняет Prometheus-scrape или даёт минимальную наблюдаемость там, где есть только внешний сборщик логов.

## Metrics

Опциональный сервер на отдельном порту (по умолчанию `127.0.0.1:9101`), не на публичном.

```
GET 127.0.0.1:9101/metrics
Authorization: Basic <base64(user:pass)>
```

Сравнение учётных данных constant-time; без верных — 401 с `WWW-Authenticate: Basic realm="metrics"`. Любой путь кроме `/metrics` — 404. На всех ответах `Cache-Control: no-store` и `X-Content-Type-Options: nosniff`. Страница ошибок разработчика отключена.

Экспозиция: gauge `unseen_memory_bytes`, `unseen_active_rooms`, `unseen_waiting_rooms`, `unseen_half_open_rooms`; counter `unseen_connections_total`, `unseen_relays_total`, `unseen_rate_limit_rejections_total`, `unseen_capacity_rejections_total`. Counters монотонные, снимок возвращает обычные числа без идентификаторов сессий.
