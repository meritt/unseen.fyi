# Unseen — протокол

Сквозное шифрование с relay посередине. Wire-уровень бинарный; plaintext-уровень — JSON envelope с дискриминатором `kind`. Сервер пересылает фреймы байт-в-байт, не имея ключей.

## Криптопримитивы

| Примитив      | Алгоритм               | API                                                  |
| ------------- | ---------------------- | ---------------------------------------------------- |
| Random        | CSPRNG                 | `crypto.getRandomValues`                             |
| KDF           | HKDF-SHA256 (RFC 5869) | Web Crypto `deriveBits`                              |
| ECDH          | X25519 (RFC 7748)      | Web Crypto, private keys non-extractable             |
| AEAD          | AES-256-GCM            | Web Crypto, 12-байтовый nonce, 16-байтовый tag       |
| Key wrapping  | AES-KW (RFC 3394)      | Web Crypto                                           |
| Потоковый хеш | SHA-256                | `@noble/hashes` (Web Crypto не имеет потокового API) |

### Проверки handshake

Все X25519-операции проверяют:

- **Reflection guard**: `peer_pub === my_pub` → отклонить. Иначе атакующий мог бы отзеркалить наш handshake.
- **Zero-secret guard**: `shared_secret == all-zero` → отклонить. Открытые ключи малого порядка дают предсказуемый all-zero shared secret.

## Размеры и лимиты

| Константа                   | Значение      | Назначение                                                                                             |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `MAX_BODY_BYTES`            | 4096          | Строгий лимит на длину `body` в UTF-8: composer блокирует отправку, кодек отклоняет на encode и decode |
| `MAX_PLAINTEXT_BYTES`       | 8704          | Строгий лимит на длину `JSON.stringify(envelope)` в UTF-8                                              |
| `MAX_WIRE_BYTES`            | 8736          | Строгая граница = 1 type + 1 kind + 12 nonce + 2 ct_len + 8704 + 16 GCM tag                            |
| `MAX_FILE_SIZE_BYTES`       | 100 MiB       | Лимит на `file_offer.size`                                                                             |
| `SESSION_RECEIVE_CAP_BYTES` | 500 MiB       | Суммарный лимит на принятые вложения за сессию (защита от злоупотреблений)                             |
| `CHUNK_DATA_MAX_BYTES`      | 8692          | `MAX_PLAINTEXT_BYTES − 8 tid − 4 seq`                                                                  |
| `PEER_BUFFER_CAP_BYTES`     | 8 MiB         | Серверный лимит буфера пересылки (per-peer)                                                            |
| `BUFFER_THRESHOLD_BYTES`    | 256 KiB       | Порог backpressure клиентского send-pipeline                                                           |
| `HELLO_DEADLINE_MS`         | 5000          | Slowloris: WS закрывается, если HELLO не пришёл                                                        |
| `GRACE_PERIOD_MS`           | 5 × 60 × 1000 | Льготный период для HALF_OPEN-комнаты; env override `UNSEEN_GRACE_MS`                                  |
| `INITIATOR_WAIT_TIMEOUT_MS` | 5 × 60 × 1000 | Максимальный возраст WAITING-комнаты без peer                                                          |
| `SWEEP_INTERVAL_MS`         | 30 000        | Период планировщика очистки; env override `UNSEEN_SWEEP_MS`                                            |

`PROTOCOL_VERSION = 1` — передаётся в HELLO.

## Деривация ключей

Из 256-битного `secret` (URL fragment) выводятся 7 значений через HKDF-SHA256 с пустым salt:

| Поле            | Длина                            | HKDF info                    | Назначение                                                 |
| --------------- | -------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `room_id`       | 16 B                             | `"unseen:v1:roomId"`         | server-visible id, передаётся в HELLO                      |
| `handshake_key` | 32 B → AES-GCM (non-extractable) | `"unseen:v1:handshake"`      | шифрование HANDSHAKE-фрейма                                |
| `sas_anchor`    | 32 B                             | `"unseen:v1:sas-anchor"`     | salt для деривации session_key и SAS                       |
| `storageKey`    | 8 B → base64url, 11 символов     | `"unseen:v1:storage"`        | непрозрачное имя записи в sessionStorage                   |
| `lockKey`       | 8 B → base64url, 11 символов     | `"unseen:v1:lock"`           | непрозрачное имя для Web Locks claim (duplicate-tab guard) |
| `prfSalt`       | 32 B                             | `"unseen:v1:prf-salt"`       | входные данные для WebAuthn PRF eval                       |
| `opfs_dir`      | 8 B → base64url, 11 символов     | `"unseen:v1:opfs:transfers"` | непрозрачное имя OPFS-поддиректории сессии                 |

Если `lockKey` начинается с `-`, первый символ заменяется на `_` — Web Locks API отвергает имена, начинающиеся с `-`.

### Деривация session_key

```
transcript    = lex_sort(eph_a_pub, eph_b_pub)        // 64 B (32 + 32)
session_key   = HKDF(
                  ikm  = ECDH(eph_a_priv, eph_b_pub),
                  salt = sas_anchor,
                  info = "unseen:v1:session-key" || transcript,
                  L    = 32
                )
                → AES-256-GCM key
sas_bytes     = HKDF(
                  ikm  = session_key_raw,
                  salt = sas_anchor,
                  info = "unseen:v1:sas",
                  L    = 5
                )
```

Лексикографическая сортировка транскрипта гарантирует одинаковый `session_key` у обеих сторон независимо от роли. `session_key` всегда создаётся как `extractable: true` — это требуется для opt-in PRF upgrade (AES-KW wrap нуждается в ключе с `extractable: true`).

### Wrap key (PRF-режим)

```
wrap_key      = HKDF(
                  ikm  = prf_output,                       // сырые байты от WebAuthn PRF
                  salt = empty,
                  info = "unseen:v1:wrap" || roomIdBytes,  // 16 сырых байт, НЕ hex
                  L    = 32
                )
                → AES-KW key (non-extractable)
```

### Rekey session_key (PRF+PRF hardened)

Когда оба peer в PRF-режиме, происходит согласованный rekey: каждая сторона генерирует новую эфемерную пару X25519, обменивается открытыми ключами через зашифрованный RELAY, выводит новый ключ:

```
new_session_key = HKDF(
                    ikm  = ECDH(my_fresh_priv, peer_fresh_pub),
                    salt = sas_anchor,
                    info = "unseen:v1:rekeyed-session-key",
                    L    = 32
                  )
                  → AES-256-GCM key (non-extractable)
```

После rekey счётчик сбрасывается в 0; новый ключ записан в хранилище с `mode_phase: 'hardened'`.

## Формат wire-фрейма

Все WebSocket-фреймы — бинарные (`ArrayBuffer`). `binaryType = 'arraybuffer'`. Frame type — первый байт.

| Type              | Byte   | Направление | Payload                                                                       |
| ----------------- | ------ | ----------- | ----------------------------------------------------------------------------- |
| HELLO             | `0x01` | C → S       | `[roomId:16][protoVer:1][intent:1]` (19 байт)                                 |
| ACK               | `0x02` | S → C       | `[role:1]`                                                                    |
| PEER_JOINED       | `0x03` | S → C       | (пусто)                                                                       |
| HANDSHAKE         | `0x04` | дв          | `[nonce:12][ciphertext:48]` (32-байтовый ephemeral pub + 16-байтовый GCM tag) |
| RELAY             | `0x05` | дв          | `[kind:1][nonce:12][ct_len:u16 LE:2][ciphertext:ct_len]`                      |
| PEER_DISCONNECTED | `0x06` | S → C       | `[graceMs:u32 LE:4]`                                                          |
| PEER_LEFT         | `0x07` | S → C       | (пусто)                                                                       |
| ERROR             | `0x08` | S → C       | `[errorCode:1]`                                                               |

Wire byte 0x06 (`MSG_PEER_DISCONNECTED`) и errorCode 0x06 (`OVER_CAPACITY`) — разные пространства имён.

### HELLO

```
[0x01][roomId:16][protoVer=1][intent]
intent: 0x01=create, 0x02=join, 0x03=resume
```

19 байт. **Поле `mode` отсутствует** — сервер не различает режимы, каждая сторона решает свою защиту локально.

### RELAY layout

```
Offset  Size    Field
0       1       0x05 (frame type)
1       1       kind (0x00 msg | 0x01 chunk | 0x10..0x13 mode upgrade & rekey)
2       12      nonce
14      2       ct_len (u16 LE)
16      ct_len  ciphertext (AES-GCM output: encrypted plaintext + 16-байтовый tag)
```

Заголовок = 16 байт. Максимальный фрейм = 16 + 8704 + 16 = **8736 байт**.

### Структура nonce

```
Offset  Size  Field
0       1     direction (0x01 initiator→joiner, 0x02 joiner→initiator)
1       8     counter (uint64 little-endian)
9       3     reserved, должны быть нулями
```

12 байт. Counter начинается с `0n` (initial state); первый отправленный пакет использует `counter = 1n`. Counter `0n` в nonce невалиден.

### Типы RELAY (kind byte)

| Kind                       | Byte   | Назначение                                            |
| -------------------------- | ------ | ----------------------------------------------------- |
| `RELAY_KIND_MSG`           | `0x00` | JSON envelope (chat / control / file metadata)        |
| `RELAY_KIND_CHUNK`         | `0x01` | бинарный чанк файла `[tid:8][seq:u32 LE][data:≤8692]` |
| `RELAY_KIND_MODE_UPGRADED` | `0x10` | peer объявляет «я теперь PRF» (пустой payload)        |
| `RELAY_KIND_REKEY_INIT`    | `0x11` | initiator шлёт fresh X25519 pubkey (32 байта)         |
| `RELAY_KIND_REKEY_ACK`     | `0x12` | joiner шлёт fresh X25519 pubkey (32 байта)            |
| `RELAY_KIND_REKEY_DONE`    | `0x13` | необязательный сигнал commit (пустой payload)         |

### Построение AAD

Каждый RELAY-фрейм шифруется с AAD = `"unseen:v1:" || [kind_byte]` (10 байт префикса + 1 байт kind). Это связывает `kind` с GCM tag — изменённый kind ломает аутентификацию, что исключает type-confusion между msg и chunk-фреймами. HANDSHAKE-фрейм использует константный AAD `"unseen:v1:handshake"`.

## Plaintext envelope

JSON, UTF-8, дискриминированное объединение по `kind`. Каждый kind имеет точный набор обязательных полей; лишние / отсутствующие — отклоняются.

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

| Поле               | Тип    | Ограничения                                                                                        |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| `body`             | string | ≤ 4096 UTF-8 байт                                                                                  |
| `t`                | string | ISO-8601 timestamp с миллисекундной точностью (на стороне отправителя)                             |
| `_id`              | string | 16 шестнадцатеричных символов                                                                      |
| `tid`              | string | 16 шестнадцатеричных символов, значение `'0000000000000000'` зарезервировано                       |
| `name`             | string | ≤ 1024 UTF-8 байт, очищается (NFC, удаление bidi / управляющих / разделителей пути, ведущая точка) |
| `size`             | number | safe integer ≥ 1, ≤ `MAX_FILE_SIZE_BYTES`                                                          |
| `sender_sha256`    | string | 64 шестнадцатеричных символа                                                                       |
| `reason` (decline) | enum   | `'too_large' \| 'user_rejected' \| 'unsupported'`                                                  |
| `reason` (cancel)  | enum   | `'user_aborted' \| 'integrity_failure' \| 'session_rekey'`                                         |
| `side` (cancel)    | enum   | `'sender' \| 'receiver'`                                                                           |

Mode upgrade и rekey kinds (`0x10`–`0x13`) **не** используют JSON envelope — их payload это сырые байты (см. таблицу выше).

## Handshake

```
1. Каждая сторона генерирует эфемерную пару X25519 (закрытый ключ non-extractable).
2. Каждая шифрует свой открытый ключ:
     HANDSHAKE.nonce      = random 12 bytes
     HANDSHAKE.ciphertext = AES-GCM(handshake_key, nonce,
                                    AAD="unseen:v1:handshake",
                                    plaintext=eph_pub_raw)
3. Шлёт HANDSHAKE-фрейм.
4. Получает HANDSHAKE от peer, расшифровывает → peer_eph_pub.
5. Reflection guard: peer_eph_pub !== my_eph_pub.
6. ECDH(my_eph_priv, peer_eph_pub) → shared_secret.
7. Zero-secret guard: shared_secret !== all-zero.
8. transcript = lex_sort(my_eph_pub, peer_eph_pub).
9. session_key = HKDF(shared_secret, sas_anchor,
                      "unseen:v1:session-key" || transcript, 32).
10. sas_bytes = HKDF(session_key_raw, sas_anchor, "unseen:v1:sas", 5).
11. Переход в ACTIVE; SAS показывается рядом с composer.
```

`session_key` всегда импортируется как `extractable: true` — это необходимо для последующего AES-KW wrap при opt-in upgrade в PRF-режим.

## SAS

Short Authentication String — 5 эмодзи из frozen pool в 256 эмодзи (40 бит энтропии). Каждый эмодзи имеет EN- и RU-локализованные имена для устной сверки.

```
sas_bytes ∈ [0..255]^5
sas_display = pool[sas_bytes[0]], pool[sas_bytes[1]], ..., pool[sas_bytes[4]]
```

UI показывает эмодзи и имена; пользователи устно сверяют по второму каналу параллельно с активной сессией. Шага подтверждения в UI нет — не сошлось, пользователь жмёт burn-кнопку.

SAS pool заморожен в `sas-emoji-v1.json`; его SHA-256 закреплён, любое изменение пула меняет хеш и ломает тесты.

40-битной энтропии достаточно против in-flight MITM (у атакующего одна попытка), но недостаточно против целенаправленного перебора в офлайне. Модель угроз — `01-overview.md`.

## Counter — инварианты

Каждая сторона держит два счётчика: `counterSend` (последний использованный) и `counterRecv` (последний принятый). Начальное состояние — оба `0n`.

### Send

1. **Persist-before-send (PRF-режим):** перед encrypt любого RELAY-фрейма счётчик (или верхняя граница пакетной резервации) должен быть сохранён в sessionStorage. Если запись бросает исключение → terminate без encrypt; нельзя отправить фрейм со счётчиком, который не сохранён.
2. **Never rollback:** счётчик монотонически растёт. После encrypt + send счётчик не уменьшается. На любую ошибку → terminate (без rollback для повтора).
3. **Persist-AHEAD batch (chunk frames):** для `kind=0x01` блок резервации = 64 счётчика. Это снижает количество записей для 100 MiB файла (~12 064 chunk → ~189 записей). После сбоя в середине пакета сохранённый счётчик впереди фактически отправленного → resume использует счётчик после сохранённого; повтор nonce исключён.
4. **Single counter (text frames):** для `kind=0x00` блок резервации = 1.

Инвариант: фактически отправленный счётчик ≤ зарезервированной (сохранённой) верхней границы; после resume следующий счётчик = верхняя граница + 1.

### Receive

1. **Strict +1 в ACTIVE:** `counter == counterRecv + 1n` (counterRecv стартует с `0n`, поэтому первый валидный принятый counter = `1n`). Любой gap или регрессия → terminate (fatal).
2. **First-gap-allowed в RESUMING / PEER_RECONNECTING:** первый RELAY после reconnect может иметь `counter > counterRecv` (peer мог отправить пакеты, пока мы были отключены, но они не дошли). После consume первого пакета mode возвращается в `strict`.
3. **Persist counterRecv (text frames):** после успешного decrypt в PRF-режиме сохраняем новый `n` в хранилище. **Chunk frames пропускают сохранение** — счётчик растёт только в RAM. Обрыв в середине передачи = RAM-счётчик теряется; resume probe ставит counterRecv в счётчик из probe (строго больше всех ранее расшифрованных чанков), любой повтор chunk → counter gap → terminate.
4. **Direction byte check:** `nonce[0]` должен совпадать с `expectedPeerDirection(myRole)`. Свой direction byte → reject (`invalid_direction`).
5. **Reserved bytes check:** `nonce[9..12]` должны быть нулями. Иначе `invalid_reserved`.

## Восстановление сессии

### Матрица intent

Клиент не знает свою роль только по URL. Initial intent определяется по storage:

| Stored mirror?                        | Первый HELLO intent |
| ------------------------------------- | ------------------- |
| Нет (включая любую пару в RAM-режиме) | `create`            |
| Да (PRF-режим после ACTIVE)           | `resume`            |

Если `intent=create` отвергнут с `ROOM_ALREADY_EXISTS` (комнату уже создал peer) → клиент молча переоткрывает WS с `intent=join`. Счётчик поколения гасит запоздавшие фреймы от прежнего соединения.

Проверки на сервере:

| intent   | комнаты нет             | WAITING                                            | HALF_OPEN                      | PAIRED                |
| -------- | ----------------------- | -------------------------------------------------- | ------------------------------ | --------------------- |
| `create` | создать + ACK initiator | `ROOM_ALREADY_EXISTS`                              | `ROOM_ALREADY_EXISTS`          | `ROOM_ALREADY_EXISTS` |
| `join`   | `ROOM_NOT_FOUND`        | занять слот + PEER_JOINED peer                     | `ROOM_FULL` (слот за resume)   | `ROOM_FULL`           |
| `resume` | `ROOM_NOT_FOUND`        | занять слот + PEER_JOINED peer (ждёт resume probe) | занять слот + PEER_JOINED peer | `ROOM_FULL`           |

### Resume probe

После reconnect (или после F5 в PRF-режиме):

```
1. Returning peer:
   - Если был mirror — unwrap session_key через WebAuthn PRF + AES-KW.
   - Открывает WS, шлёт HELLO {intent: resume, roomId}.
   - На PEER_JOINED отправляет RELAY {kind: 'resume', _id}.
2. Остающийся peer:
   - Видит PEER_JOINED (returning peer занял слот).
   - Ставит nextRecvMode = 'first-gap-allowed' для первого RELAY от вернувшегося.
   - Получает RELAY, decrypt OK + envelope.kind === 'resume' + counter > recv → принимает.
   - Отвечает RELAY {kind: 'resume_ack', _id}.
3. Returning peer:
   - Получает RELAY, decrypt OK + envelope.kind === 'resume_ack' → ACTIVE.
4. Остающийся peer:
   - После отправки resume_ack flip nextRecvMode = 'strict', переход в ACTIVE.
```

Верхняя граница ожидания resume probe — серверный льготный период очистки (`GRACE_PERIOD_MS`, 5 минут); по истечении сервер шлёт PEER_LEFT.

### Расписание auto-reconnect (только PRF-режим)

При собственном обрыве WS в ACTIVE / PEER_RECONNECTING / RESUMING:

```
BACKOFF_SCHEDULE_MS = [1, 2, 4, 8, 16, 30, 60] секунд
RECONNECT_CUMULATIVE_CAP_MS = 5 * 60 * 1000  // совпадает с серверным льготным периодом
```

После cap → `terminate('reconnect_exhausted')`. RAM-режим не делает reconnect — любой WS close → terminate сразу. Initial WS connect (CONNECTING state) не использует reconnect engine.

### Преемственность session_key между resume

После успешного resume используется **тот же** `session_key`. Rekey между reconnect не делается. Изоляция ключевого материала — между сессиями (разные `secret` → независимые `session_key`, `prfSalt`, WebAuthn credentials), не внутри одной.

## Двухступенчатая защита sessionStorage

| Фаза                      | session_key                                                                                        | persist                                               | trigger                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| **1. RAM**                | extractable в JS heap, в storage не пишется                                                        | нет                                                   | по умолчанию при загрузке                    |
| **2. Soft upgrade (PRF)** | extractable, обёрнут AES-KW в storage с `mode_phase: 'soft'`                                       | клик по upgrade → регистрация passkey → wrap + запись | UI opt-in                                    |
| **3. PRF+PRF hardened**   | **non-extractable** (свежий после rekey), обёрнут и записан в хранилище с `mode_phase: 'hardened'` | оба peer переведены в PRF → согласованный rekey       | автоматически когда оба `peerMode === 'PRF'` |

### Процедура upgrade (Фаза 1 → Фаза 2)

1. Пользователь нажимает «Enable F5 resilience»; сессия переходит в `UPGRADING_LOCAL` (composer заблокирован).
2. Запрашивается регистрация WebAuthn-passkey для комнаты с расширением PRF (eval на `prfSalt`).
3. Пользователь отменил диалог → возврат в `ACTIVE` без изменений, RAM-режим сохраняется.
4. Расширение PRF не выдало результат (или транспортная ошибка) → остаёмся в `ACTIVE` / RAM с системным сообщением `mode_upgrade_failed`. Апгрейд опционален: его провал не трогает текущую сессию.
5. `wrap_key = HKDF(prf_output, "unseen:v1:wrap" || roomIdBytes, 32)` → AES-KW.
6. `wrapped = AES-KW(wrap_key, session_key_raw)`; запись `StoredSession` с `mode_phase: 'soft'`.
7. `sessionMode = 'PRF'`; peer уведомляется RELAY `mode_upgraded`.
8. Возврат в `ACTIVE`.

### Процедура rekey (Фаза 2 → Фаза 3)

Триггер: `sessionMode === 'PRF' && peerMode === 'PRF'`. Initiator (известен с handshake) детерминированно решает, кто шлёт `rekey_init`.

```
Initiator:
1. Генерирует новую эфемерную пару X25519.
2. Помечает StoredSession маркером rekey_in_progress.
3. Переход в REKEYING; composer заблокирован, активные передачи файлов отменяются с reason 'session_rekey'.
4. RELAY {kind: rekey_init, payload: new_pub_I}, зашифрован под текущим extractable-ключом.

Joiner:
5. Получает rekey_init, генерирует новую эфемерную пару X25519.
6. Помечает StoredSession маркером rekey_in_progress; переход в REKEYING.
7. RELAY {kind: rekey_ack, payload: new_pub_J}.

Обе стороны:
8.  shared = ECDH(my_new_priv, peer_new_pub).
9.  new_session_key = HKDF(shared, sas_anchor,
                           "unseen:v1:rekeyed-session-key", 32) → AES-256-GCM non-extractable.
10. counterSend = counterRecv = 0n.
11. wrapped = AES-KW(wrap_key, new_session_key_raw) (wrap_key переиспользуется);
    StoredSession обновляется: новый wrapped, счётчики '0', mode_phase: 'hardened'.
12. RELAY {kind: rekey_done} (опционально, для наблюдаемости).
13. Переход в ACTIVE; UI-бейдж «Session hardened».
```

После rekey оригинальный extractable `session_key` отбрасывается. Новый `session_key` non-extractable; `subtle.exportKey()` на нём throws.

### Обработка сбоев

- F5 mid-rekey: `rekey_in_progress: true` присутствует в хранилище. При загрузке такая запись очищается, начинается новая RAM-сессия.
- Rekey timeout / decrypt fail / counter gap во время REKEYING: terminate.

## TERMINATED

Финализация идёт в фиксированном порядке: состояние сразу становится `TERMINATED` (немедленно для UI); в PRF-режиме менеджеру учётных данных fire-and-forget отправляется сигнал, что per-room passkey можно удалить; запись `StoredSession` очищается; claim Web Lock (защита от повторной вкладки) освобождается.

Если `reason ∈ {user_panic, duplicate_tab}` (мгновенные причины) — финализация без задержки.

Если причина не мгновенная и `sessionState ∈ {ACTIVE, PEER_RECONNECTING, RECONNECTING}` — переход в `FATAL_ENDING` на `FATAL_BUFFER_MS = 3000` мс (overlay «session ending…»), затем финализация.

Коды причин — внутренний аргумент завершения, в wire не уходят (WS Close шлётся без reason). UI показывает единое уведомление о завершении сессии; отдельный текст есть только у `duplicate_tab`. Примеры причин: `user_panic`, `duplicate_tab`, `peer_gone`, `decrypt_failed`, `counter_gap`, `invalid_direction`, `reconnect_exhausted`, `storage_fail`, `server_error_<code>` (см. таблицу кодов ошибок), `passkey_resume_*`.

## Коды ошибок (wire)

| Byte   | Code                  | Когда                                                         |
| ------ | --------------------- | ------------------------------------------------------------- |
| `0x01` | `INVALID_HELLO`       | некорректный HELLO-фрейм                                      |
| `0x02` | `UNSUPPORTED_VERSION` | несоответствие protocolVersion                                |
| `0x03` | `ROOM_FULL`           | 3-й клиент пытается join в PAIRED-комнату                     |
| `0x04` | `ROOM_NOT_FOUND`      | join/resume на несуществующую комнату                         |
| `0x05` | `ROOM_ALREADY_EXISTS` | create на существующую (штатно — клиент повторяет как `join`) |
| `0x06` | `OVER_CAPACITY`       | **reserved** (глобального лимита комнат нет)                  |
| `0x07` | `RATE_LIMITED`        | per-IP token bucket исчерпан                                  |
| `0x08` | `MESSAGE_TOO_LARGE`   | фрейм > MAX_WIRE_BYTES                                        |
| `0x09` | `INVALID_PAYLOAD`     | некорректный wire-фрейм (плохой kind / несовпадение ct_len)   |
| `0x0a` | `BAD_STATE`           | неподходящий тип фрейма для текущего состояния комнаты        |
| `0x0b` | `HELLO_TIMEOUT`       | HELLO не пришёл за HELLO_DEADLINE_MS                          |
| `0x0c` | `MODE_MISMATCH`       | **reserved**, сервер не различает режимы                      |
| `0xff` | `INTERNAL`            | необработанное исключение на сервере                          |

## Storage schema

`sessionStorage[storageKey]` — одна запись под непрозрачным base64url-именем (11 символов, HKDF-derived):

```typescript
type StoredSession = {
  r: 'i' | 'j'; // роль (initiator | joiner)
  k: string; // base64url(AES-KW(wrap_key, session_key_raw)) — 40 байт wrapped
  s: string; // counterSend, decimal bigint
  n: string; // counterRecv, decimal bigint
  cid: string; // base64url(credential.rawId)
  sas?: string; // base64url(5-байтовый SAS), для UI после F5
  mode_phase?: 'soft' | 'hardened'; // 'soft' = wrapped extractable, 'hardened' = wrapped non-extractable
  rekey_in_progress?: boolean; // true mid-rekey; boot с этим маркером → очистить + fresh RAM
};
```

**Инварианты:**

- Запись пишется только после `UPGRADING_LOCAL → ACTIVE` (soft upgrade) или после `REKEYING → ACTIVE` (hardened rekey). В RAM-режиме storage пуст.
- Сырые байты `session_key` никогда не попадают в storage — только wrapped.
- Single-letter имена полей — экономия места и меньше утечки схемы через осмотр в DevTools.
- `localStorage` разрешает **ровно один** ключ `LANG_STORAGE_KEY = 'c7XmK9-bN4q'` со значением `'en' \| 'ru'` (пользовательская настройка между перезагрузками вкладки). Чувствительные данные в localStorage не разрешены.

### Пространство имён OPFS (передача файлов)

Непрозрачное имя директории на сессию: `base64url(HKDF(secret, "unseen:v1:opfs:transfers", 8))` — 11 символов. Singleton lock `OPFS_LOCK_NAME = 'X_TbN9q4-pZ'` координирует boot-sweep против активных передающих Worker через `navigator.locks`. На каждый boot — sweep всех директорий с непрозрачными именами, кроме текущей сессии. На BFCache restore — sweep всех (страница уже выгружается, новый boot сделает полную очистку). Живая сессия дополнительно держит shared lock, имя которого совпадает с именем её директории (захват до создания директории, авто-release при уничтожении документа); каждый sweep пропускает директории, чьи имена числятся held или pending в `navigator.locks.query()`, — директория активной сессии в другой вкладке не удаляется. Имя lock совпадает с уже непрозрачным именем директории и новых данных не раскрывает.

## Frozen-артефакты

Test vectors и SAS pool закреплены по SHA-256. Любая правка JSON-файлов меняет хеш и ломает тесты — повышение версии протокола требует осознанного обновления закреплённых хешей. Закреплены три файла: `sas-emoji-v1.json`, `test-vectors-v1.json`, `test-vectors-file-v1.json`.

Test vectors включают: выходы HKDF для всех info-строк, known-answer tests для X25519, round-trip AES-GCM с примерными nonce + counter + AAD, деривацию SAS из известного session_key, кодек RELAY-фрейма, порядок транскрипта handshake, round-trip AES-KW, разметку chunk-фрейма с AAD.
