# Unseen — протокол

Сквозное шифрование с relay посередине. Wire-уровень бинарный, plaintext-уровень — JSON envelope с дискриминатором `kind`. Сервер пересылает фреймы байт-в-байт, ключей не имея.

## Криптопримитивы

| Примитив      | Алгоритм               | API                                                  |
| ------------- | ---------------------- | ---------------------------------------------------- |
| Random        | CSPRNG                 | `crypto.getRandomValues`                             |
| KDF           | HKDF-SHA256 (RFC 5869) | Web Crypto `deriveBits`, salt пустой, если не указан |
| ECDH          | X25519 (RFC 7748)      | Web Crypto, закрытые ключи non-extractable           |
| AEAD          | AES-256-GCM            | Web Crypto, nonce 12 байт, tag 16 байт               |
| Key wrapping  | AES-KW (RFC 3394)      | Web Crypto                                           |
| Потоковый хеш | SHA-256                | `@noble/hashes` (Web Crypto не имеет потокового API) |

## Размеры и лимиты

| Константа                   | Значение      | Назначение                                                                            |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| `MAX_BODY_BYTES`            | 4096          | длина `body` в UTF-8: composer блокирует отправку, кодек отклоняет на encode и decode |
| `MAX_PLAINTEXT_BYTES`       | 8704          | длина `JSON.stringify(envelope)` в UTF-8                                              |
| `MAX_WIRE_BYTES`            | 8736          | граница фрейма = 1 type + 1 kind + 12 nonce + 2 ct_len + 8704 + 16 GCM tag            |
| `CHUNK_DATA_MAX_BYTES`      | 8692          | `MAX_PLAINTEXT_BYTES − 8 tid − 4 seq`                                                 |
| `MAX_FILE_SIZE_BYTES`       | 100 MiB       | лимит на `file_offer.size`                                                            |
| `SESSION_RECEIVE_CAP_BYTES` | 500 MiB       | суммарный лимит на принятые вложения за сессию                                        |
| `PEER_BUFFER_CAP_BYTES`     | 8 MiB         | серверный лимит буфера пересылки (per-peer)                                           |
| `BUFFER_THRESHOLD_BYTES`    | 256 KiB       | порог backpressure клиентского send-pipeline                                          |
| `HELLO_DEADLINE_MS`         | 5000          | slowloris: WS закрывается, если HELLO не пришёл                                       |
| `GRACE_PERIOD_MS`           | 5 × 60 × 1000 | льготный период `HALF_OPEN`-комнаты, override `UNSEEN_GRACE_MS`                       |
| `INITIATOR_WAIT_TIMEOUT_MS` | 5 × 60 × 1000 | максимальный возраст `WAITING`-комнаты без peer                                       |
| `SWEEP_INTERVAL_MS`         | 30 000        | период планировщика очистки, override `UNSEEN_SWEEP_MS`                               |

`PROTOCOL_VERSION = 1`, передаётся в HELLO.

## Деривация ключей

Из 256-битного `secret` (URL fragment) выводятся семь значений через HKDF-SHA256 с пустым salt:

| Поле            | Длина                            | HKDF info                    | Назначение                                              |
| --------------- | -------------------------------- | ---------------------------- | ------------------------------------------------------- |
| `room_id`       | 16 B                             | `"unseen:v1:roomId"`         | видимый серверу id, передаётся в HELLO                  |
| `handshake_key` | 32 B → AES-GCM (non-extractable) | `"unseen:v1:handshake"`      | шифрование HANDSHAKE-фрейма                             |
| `sas_anchor`    | 32 B                             | `"unseen:v1:sas-anchor"`     | salt для деривации session_key и SAS                    |
| `storageKey`    | 8 B → base64url, 11 символов     | `"unseen:v1:storage"`        | непрозрачное имя записи в `sessionStorage`              |
| `lockKey`       | 8 B → base64url, 11 символов     | `"unseen:v1:lock"`           | непрозрачное имя Web Lock (защита от повторной вкладки) |
| `prfSalt`       | 32 B                             | `"unseen:v1:prf-salt"`       | входные данные для WebAuthn PRF eval                    |
| `opfs_dir`      | 8 B → base64url, 11 символов     | `"unseen:v1:opfs:transfers"` | непрозрачное имя OPFS-директории сессии                 |

Ведущий `-` в `lockKey` заменяется на `_`: Web Locks API отвергает имена, начинающиеся с дефиса.

```
transcript      = lex_sort(eph_a_pub, eph_b_pub)              // 64 B
session_key     = HKDF(ikm  = ECDH(eph_a_priv, eph_b_pub),
                       salt = sas_anchor,
                       info = "unseen:v1:session-key" || transcript, L = 32)   → AES-256-GCM
sas_bytes       = HKDF(ikm = session_key_raw, salt = sas_anchor,
                       info = "unseen:v1:sas", L = 5)

wrap_key        = HKDF(ikm  = prf_output,                     // сырые байты WebAuthn PRF
                       info = "unseen:v1:wrap" || roomIdBytes, L = 32)         → AES-KW
new_session_key = HKDF(ikm  = ECDH(my_fresh_priv, peer_fresh_pub),
                       salt = sas_anchor,
                       info = "unseen:v1:rekeyed-session-key", L = 32)         → AES-256-GCM
```

Лексикографическая сортировка транскрипта даёт обеим сторонам одинаковый `session_key` независимо от роли. Исходный `session_key` всегда создаётся `extractable: true` — этого требует AES-KW wrap при opt-in апгрейде. Ключ после rekey non-extractable, `roomIdBytes` в info для `wrap_key` — 16 сырых байт, не hex.

## Формат wire-фрейма

Все WebSocket-фреймы бинарные (`binaryType = 'arraybuffer'`), тип фрейма — первый байт.

| Type              | Byte   | Направление | Payload                                                |
| ----------------- | ------ | ----------- | ------------------------------------------------------ |
| HELLO             | `0x01` | C → S       | `[roomId:16][protoVer:1][intent:1]`, всего 19 байт     |
| ACK               | `0x02` | S → C       | `[role:1]`                                             |
| PEER_JOINED       | `0x03` | S → C       | пусто                                                  |
| HANDSHAKE         | `0x04` | дв          | `[nonce:12][ciphertext:48]`, всего 61 байт             |
| RELAY             | `0x05` | дв          | `[kind:1][nonce:12][ct_len:u16 LE][ciphertext:ct_len]` |
| PEER_DISCONNECTED | `0x06` | S → C       | `[graceMs:u32 LE]`                                     |
| PEER_LEFT         | `0x07` | S → C       | пусто                                                  |
| ERROR             | `0x08` | S → C       | `[errorCode:1]`                                        |

Wire-байт `0x06` (PEER_DISCONNECTED) и errorCode `0x06` (`OVER_CAPACITY`) — разные пространства имён. `intent`: `0x01` create, `0x02` join, `0x03` resume. Поля `mode` в HELLO нет: сервер не различает режимы, каждая сторона решает свою защиту локально.

Заголовок RELAY — 16 байт (`0x05`, kind, nonce со смещения 2, `ct_len` со смещения 14), максимальный фрейм 16 + 8704 + 16 = **8736 байт**.

**Nonce**, 12 байт: `[direction:1][counter:u64 LE:8][reserved:3]`. Direction — `0x01` initiator→joiner, `0x02` joiner→initiator; reserved обязаны быть нулями. Счётчик стартует с `0n`, первый отправленный кадр использует `1n`, поэтому `0n` в nonce невалиден.

| Kind                       | Byte   | Назначение                                        |
| -------------------------- | ------ | ------------------------------------------------- |
| `RELAY_KIND_MSG`           | `0x00` | JSON envelope (чат, служебные, метаданные файлов) |
| `RELAY_KIND_CHUNK`         | `0x01` | бинарный чанк `[tid:8][seq:u32 LE][data:≤8692]`   |
| `RELAY_KIND_MODE_UPGRADED` | `0x10` | peer объявляет «я теперь PRF», payload пустой     |
| `RELAY_KIND_REKEY_INIT`    | `0x11` | initiator шлёт свежий X25519 pubkey (32 байта)    |
| `RELAY_KIND_REKEY_ACK`     | `0x12` | joiner шлёт свежий X25519 pubkey (32 байта)       |
| `RELAY_KIND_REKEY_DONE`    | `0x13` | необязательный сигнал commit, payload пустой      |

**AAD.** Каждый RELAY шифруется с AAD `"unseen:v1:" || [kind_byte]` — 11 байт. Это связывает `kind` с GCM tag: изменённый kind ломает аутентификацию, что исключает type confusion между msg и chunk. HANDSHAKE использует константный AAD `"unseen:v1:handshake"`.

## Plaintext envelope

JSON в UTF-8, дискриминированное объединение по `kind`. Набор полей у каждого kind точный: лишние и отсутствующие отклоняются.

```typescript
type PlaintextEnvelope =
  | { kind: 'msg'; body: string; t: string }
  | { kind: 'resume'; _id: string }
  | { kind: 'resume_ack'; _id: string }
  | { kind: 'file_offer'; tid: string; name: string; size: number }
  | { kind: 'file_accept'; tid: string }
  | { kind: 'file_decline'; tid: string; reason: FileDeclineReason }
  | { kind: 'file_progress'; tid: string; received_bytes: number }
  | { kind: 'file_complete'; tid: string; sender_sha256: string }
  | { kind: 'file_complete_ack'; tid: string }
  | { kind: 'file_cancel'; tid: string; side: FileCancelSide; reason: FileCancelReason };
```

| Поле               | Ограничения                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `body`             | ≤ 4096 UTF-8 байт                                                                            |
| `t`                | ISO-8601 с миллисекундами, по часам отправителя                                              |
| `_id`, `tid`       | 16 шестнадцатеричных символов; `tid` = `'0000000000000000'` зарезервирован и отклоняется     |
| `name`             | ≤ 1024 UTF-8 байт; получатель чистит имя сам (см. `03-client.md`)                            |
| `size`             | safe integer ≥ 1; потолок `MAX_FILE_SIZE_BYTES` проверяет получатель, кодек его не применяет |
| `received_bytes`   | safe integer ≥ 0                                                                             |
| `sender_sha256`    | 64 шестнадцатеричных символа                                                                 |
| `reason` (decline) | `'too_large' \| 'user_rejected' \| 'unsupported'`                                            |
| `reason` (cancel)  | `'user_aborted' \| 'integrity_failure' \| 'session_rekey'`                                   |
| `side` (cancel)    | `'sender' \| 'receiver'`                                                                     |

Kinds `0x10`–`0x13` JSON не используют: их payload — сырые байты.

## Handshake

```
1. Каждая сторона генерирует эфемерную пару X25519 (закрытый ключ non-extractable).
2. Шифрует свой открытый ключ: AES-GCM(handshake_key, random nonce,
   AAD = "unseen:v1:handshake", plaintext = eph_pub_raw) и шлёт HANDSHAKE.
3. Получает HANDSHAKE от peer, расшифровывает → peer_eph_pub.
4. shared_secret = ECDH(my_eph_priv, peer_eph_pub).
5. Zero-secret guard: shared_secret не all-zero — открытые ключи малого порядка дают
   предсказуемый all-zero секрет.
6. Reflection guard: peer_eph_pub !== my_eph_pub, иначе атакующий отзеркалил бы наш handshake.
7. session_key и sas_bytes по формулам выше; переход в ACTIVE, SAS рядом с composer.
```

## SAS

Short Authentication String — 5 эмодзи из замороженного пула в 256 эмодзи, то есть 40 бит энтропии; у каждого эмодзи есть EN- и RU-имя для устной сверки. Индексы берутся побайтово: `sas_display[i] = pool[sas_bytes[i]]`.

Шага подтверждения в UI нет: пользователи сверяют по второму каналу параллельно с активной сессией, а при расхождении жмут burn. 40 бит достаточно против in-flight MITM (у атакующего одна попытка) и недостаточно против целенаправленного офлайн-перебора; модель угроз — `01-overview.md`.

## Счётчики

Каждая сторона держит `counterSend` (последний использованный) и `counterRecv` (последний принятый), оба стартуют с `0n`.

**Отправка.**

1. **Persist-before-send (PRF).** Перед encrypt любого RELAY счётчик, а для пакетной резервации её верхняя граница, обязан быть сохранён в `sessionStorage`. Сбой записи → terminate без encrypt: отправить кадр со счётчиком, который не сохранён, нельзя.
2. **Never rollback.** Счётчик монотонно растёт и после encrypt и send не уменьшается. Любая ошибка после инкремента → terminate, без отката ради повтора.
3. **Persist-AHEAD для чанков.** Для `kind=0x01` блок резервации 64 счётчика: это снижает число записей для 100 MiB файла (~12 064 чанка → ~189 записей). После сбоя в середине пакета сохранённый счётчик впереди фактически отправленного, resume продолжает с сохранённого — повтор nonce исключён.
4. **Одиночный блок для текста.** Для `kind=0x00` блок резервации равен 1.

Инвариант: фактически отправленный счётчик ≤ зарезервированной верхней границы, после resume следующий счётчик = верхняя граница + 1.

**Приём.**

1. **Strict +1 в ACTIVE.** Ожидается `counter == counterRecv + 1n`, поэтому первый валидный принятый счётчик — `1n`. Любой разрыв или регрессия → terminate.
2. **First-gap-allowed в RESUMING и PEER_RECONNECTING.** Первый RELAY после reconnect может иметь `counter > counterRecv`: peer мог отправлять кадры, пока мы были отключены. После первого принятого кадра режим возвращается в strict.
3. **Persist counterRecv.** Для текстовых кадров в PRF-режиме новый счётчик сохраняется. Чанки сохранение пропускают, счётчик растёт только в RAM: обрыв в середине передачи теряет его, resume probe ставит `counterRecv` из probe (он строго больше всех расшифрованных чанков), поэтому любой повтор чанка даёт разрыв и terminate.
4. **Direction byte.** `nonce[0]` обязан совпасть с ожидаемым направлением peer; свой байт направления → `invalid_direction`.
5. **Reserved.** `nonce[9..12]` обязаны быть нулями, иначе `invalid_reserved`.

## Восстановление сессии

Роль по URL неизвестна, начальный intent определяется хранилищем: зеркала нет (в том числе у любой пары в RAM-режиме) → `create`; зеркало есть (PRF после ACTIVE) → `resume`. Отказ `ROOM_ALREADY_EXISTS` на `create` означает, что комнату уже создал peer: клиент молча переоткрывает WS с `intent=join`, а счётчик поколения гасит запоздавшие кадры прежнего соединения.

Проверки на сервере:

| intent   | комнаты нет             | WAITING                        | HALF_OPEN                      | PAIRED                |
| -------- | ----------------------- | ------------------------------ | ------------------------------ | --------------------- |
| `create` | создать + ACK initiator | `ROOM_ALREADY_EXISTS`          | `ROOM_ALREADY_EXISTS`          | `ROOM_ALREADY_EXISTS` |
| `join`   | `ROOM_NOT_FOUND`        | занять слот + PEER_JOINED peer | `ROOM_FULL` (слот за resume)   | `ROOM_FULL`           |
| `resume` | `ROOM_NOT_FOUND`        | занять слот + PEER_JOINED peer | занять слот + PEER_JOINED peer | `ROOM_FULL`           |

**Resume probe** после reconnect или F5 в PRF-режиме:

```
1. Вернувшийся: при наличии зеркала unwrap session_key (WebAuthn PRF + AES-KW),
   открывает WS с HELLO {intent: resume}, на ACK шлёт RELAY {kind: 'resume', _id}.
2. Оставшийся: видит PEER_JOINED, ставит режим приёма first-gap-allowed, принимает
   RELAY при decrypt OK и counter > recv, отвечает RELAY {kind: 'resume_ack', _id}.
3. Вернувшийся: получает resume_ack → ACTIVE.
4. Оставшийся: после отправки resume_ack возвращает strict и переходит в ACTIVE.
```

Верхняя граница ожидания probe — серверный льготный период (5 минут), по истечении сервер шлёт PEER_LEFT.

**Auto-reconnect только в PRF-режиме.** При собственном обрыве WS в ACTIVE, PEER_RECONNECTING или RESUMING: `BACKOFF_SCHEDULE_MS = [1, 2, 4, 8, 16, 30, 60]` секунд с кумулятивным потолком `RECONNECT_CUMULATIVE_CAP_MS` 5 минут, совпадающим с серверным льготным периодом; по достижении потолка `terminate('reconnect_exhausted')`. RAM-режим reconnect не делает: любой WS close завершает сессию. Первичное подключение (`CONNECTING`) через reconnect-движок не идёт.

После успешного resume используется **тот же** `session_key`: rekey между reconnect не делается. Изоляция ключевого материала — между сессиями (разные `secret` дают независимые `session_key`, `prfSalt` и WebAuthn credentials), не внутри одной.

## Двухступенчатая защита

| Фаза              | session_key                             | Хранилище                                 | Триггер                               |
| ----------------- | --------------------------------------- | ----------------------------------------- | ------------------------------------- |
| **1. RAM**        | extractable, только в JS heap           | не пишется                                | по умолчанию при загрузке             |
| **2. Soft (PRF)** | extractable, обёрнут AES-KW             | `StoredSession`, `mode_phase: 'soft'`     | клик по upgrade и регистрация passkey |
| **3. Hardened**   | **non-extractable**, свежий после rekey | `StoredSession`, `mode_phase: 'hardened'` | оба peer в PRF                        |

**Фаза 1 → 2.** Пользователь нажимает кнопку повышения защиты, сессия переходит в `UPGRADING_LOCAL` с заблокированной отправкой. Запрашивается регистрация WebAuthn-passkey для комнаты с расширением PRF (eval на `prfSalt`). Отмена диалога возвращает в `ACTIVE` без изменений; отсутствие результата PRF или транспортная ошибка оставляют `ACTIVE` и RAM с системным сообщением `mode_upgrade_failed` — апгрейд опционален, его провал не трогает сессию. При успехе выводится `wrap_key`, `session_key` оборачивается AES-KW, пишется `StoredSession` с `mode_phase: 'soft'`, режим становится PRF, peer уведомляется RELAY `mode_upgraded`, сессия возвращается в `ACTIVE`.

**Фаза 2 → 3** запускается, когда свой режим и режим peer оба PRF. Кто шлёт `rekey_init`, определяет роль initiator, известная с handshake.

```
Initiator: переходит в REKEYING (отправка заблокирована, активные передачи файлов
           отменяются с reason 'session_rekey'), помечает StoredSession маркером
           rekey_in_progress, генерирует новую эфемерную пару X25519 и шлёт
           RELAY {kind: rekey_init, payload: new_pub_I} под текущим ключом.
Joiner:    на rekey_init переходит в REKEYING, ставит тот же маркер, генерирует свою
           пару и отвечает RELAY {kind: rekey_ack, payload: new_pub_J}.
Обе:       new_session_key = HKDF(ECDH(my_new_priv, peer_new_pub), sas_anchor,
                                  "unseen:v1:rekeyed-session-key", 32)  → non-extractable;
           counterSend = counterRecv = 0n;
           StoredSession обновляется (новый wrapped тем же wrap_key, счётчики '0',
           mode_phase: 'hardened'); опционально RELAY {kind: rekey_done};
           переход в ACTIVE, бейдж «Session hardened».
```

Исходный extractable `session_key` после rekey отбрасывается, `subtle.exportKey()` на новом бросает. F5 в середине rekey оставляет `rekey_in_progress: true` в хранилище: при загрузке такая запись очищается и начинается новая RAM-сессия. Сбой decrypt и разрыв счётчика во время REKEYING завершают сессию.

## TERMINATED

Финализация идёт в фиксированном порядке: состояние сразу становится `TERMINATED` (немедленно для UI); в PRF-режиме менеджеру учётных данных fire-and-forget уходит сигнал, что per-room passkey можно удалить; запись `StoredSession` очищается; claim Web Lock освобождается; внутреннее состояние сессии сбрасывается в вариант без ключей, поэтому дескриптор `session_key` после terminate не живёт и любая проверка «сессия активна» отказывает.

С момента terminate сессия ничего не пишет и не отправляет: сохранение записи бросает, а работа, начатая раньше (расшифровка входящего кадра, rekey, регистрация passkey), по возвращении из ожидания не меняет ни состояние, ни хранилище. Passkey, созданный уже после завершения, сразу получает сигнал удаления.

Мгновенные причины (`user_panic`, `duplicate_tab`) финализируются без задержки. В остальных случаях из `ACTIVE`, `PEER_RECONNECTING` и `RECONNECTING` сессия сначала переходит в `FATAL_ENDING` на `FATAL_BUFFER_MS = 3000` мс с overlay завершения.

Причины — внутренний аргумент завершения, в wire не уходят (WS Close шлётся без reason). UI показывает единое уведомление о завершении, отдельный текст есть только у `duplicate_tab`. Семейства причин: пользовательские (`user_panic`, `user_ended_resume`), защитные (`duplicate_tab`, `peer_gone`, `reconnect_exhausted`, `storage_fail`), приёмные с префиксом (`relay_decrypt_failed`, `relay_counter_gap`, `relay_invalid_direction`, `relay_malformed_envelope`, `mode_frame_*`), фазовые (`handshake_*`, `resume_*`, `rekey_*`, `passkey_resume_*`) и серверные (`server_error_<код>`, `ws_close_*`, `protocol_*`).

## Коды ошибок

| Byte   | Code                  | Когда                                                         |
| ------ | --------------------- | ------------------------------------------------------------- |
| `0x01` | `INVALID_HELLO`       | некорректный HELLO-фрейм                                      |
| `0x02` | `UNSUPPORTED_VERSION` | несоответствие `protocolVersion`                              |
| `0x03` | `ROOM_FULL`           | третий клиент или занятый слот                                |
| `0x04` | `ROOM_NOT_FOUND`      | join или resume на несуществующую комнату                     |
| `0x05` | `ROOM_ALREADY_EXISTS` | create на существующую (штатно — клиент повторяет как `join`) |
| `0x06` | `OVER_CAPACITY`       | соединение сверх потолка relay                                |
| `0x07` | `RATE_LIMITED`        | исчерпан per-IP или per-connection bucket                     |
| `0x08` | `MESSAGE_TOO_LARGE`   | фрейм больше `MAX_WIRE_BYTES`                                 |
| `0x09` | `INVALID_PAYLOAD`     | некорректный wire-фрейм                                       |
| `0x0a` | `BAD_STATE`           | неподходящий тип фрейма для состояния соединения              |
| `0x0b` | `HELLO_TIMEOUT`       | HELLO не пришёл за `HELLO_DEADLINE_MS`                        |
| `0x0c` | `MODE_MISMATCH`       | **зарезервирован**, сервер не различает режимы                |
| `0xff` | `INTERNAL`            | необработанное исключение на сервере                          |

## Storage schema

`sessionStorage[storageKey]` — одна запись под непрозрачным именем:

```typescript
type StoredSession = {
  r: 'i' | 'j'; // роль
  k: string; // base64url(AES-KW(wrap_key, session_key_raw))
  s: string; // верхняя граница резервации counterSend, десятичный bigint
  n: string; // counterRecv, десятичный bigint
  cid: string; // base64url(credential.rawId)
  sas?: string; // base64url(5 байт SAS), для UI после F5
  mode_phase?: 'soft' | 'hardened';
  rekey_in_progress?: boolean; // boot с этим маркером → очистить и начать RAM-сессию
};
```

Инварианты: запись появляется только после `UPGRADING_LOCAL → ACTIVE` или `REKEYING → ACTIVE`, в RAM-режиме хранилище пусто; сырые байты `session_key` в хранилище не попадают, только wrapped; однобуквенные имена полей экономят место и меньше раскрывают схему при осмотре в DevTools. В `localStorage` разрешён ровно один ключ `'c7XmK9-bN4q'` со значением `'en' | 'ru'`; чувствительные данные там запрещены.

**OPFS.** Имя директории сессии — `base64url(HKDF(secret, "unseen:v1:opfs:transfers", 8))`, 11 символов. Singleton lock `OPFS_LOCK_NAME = 'X_TbN9q4-pZ'` координирует boot-sweep с активными передающими воркерами. На каждый boot чистятся все директории с непрозрачными именами, кроме текущей; на BFCache restore — все, поскольку страница уже выгружается. Живая сессия держит shared lock, имя которого совпадает с именем её директории (захват до создания директории, авто-release при уничтожении документа); sweep пропускает директории, чьи имена числятся held или pending в `navigator.locks.query()`, поэтому директория активной сессии в другой вкладке не удаляется. Имя lock совпадает с уже непрозрачным именем директории и новых данных не раскрывает.

## Frozen-артефакты

`sas-emoji-v1.json`, `test-vectors-v1.json` и `test-vectors-file-v1.json` закреплены по SHA-256. Любая правка меняет хеш и ломает тесты: повышение версии протокола требует осознанного обновления закреплённых значений.

Векторы покрывают выходы HKDF для всех info-строк, known-answer tests для X25519, деривацию session_key и SAS, round-trip AES-GCM с nonce, счётчиком и AAD, round-trip AES-KW, кодек RELAY-фрейма, порядок транскрипта handshake, разметку chunk-фрейма с AAD и rekey.
