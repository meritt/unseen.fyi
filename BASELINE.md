# Platform baseline

Web-platform features Unseen depends on that are not yet Widely available — capabilities adopted early and tracked toward interop — plus what we await. No fallbacks, no polyfills.

Targets: Chrome 149 · Firefox 151 · Safari 26.5 · Bun 1.3.14.
Support verified 2026-06-14.

## Client

Every row ships in all three target engines; _Limited_ marks Baseline's label, not a support gap.

| Capability                 | Chrome | FF  | Safari | Baseline      | API / where                                                                                                             |
| -------------------------- | :----: | :-: | :----: | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| CSS anchor positioning     |  125   | 147 |   26   | Limited       | `anchor-name`, `position-anchor`, `anchor()`, `anchor-scope` — tooltip pills, `utilities.css`                           |
| WebAuthn PRF               |  132   | 139 |   18   | Limited       | `credentials.create/get({extensions:{prf}})` — opt-in PRF mode, `domain/passkey.ts`                                     |
| Trusted Types              |   83   | 148 |   26   | Newly 2026-02 | `require-trusted-types-for 'script'` CSP, `trustedTypes.createPolicy` — `static/headers.ts`, `workers/create-worker.ts` |
| X25519 ECDH                |  133   | 130 |   17   | Newly 2025    | `crypto.subtle` `deriveBits({name:'X25519'})` — `shared/crypto/x25519.ts`                                               |
| Navigation API             |  102   | 147 |  26.2  | Newly 2026-01 | `navigation.navigate('/', { history: 'replace' })` — invalid-route redirect, `main.ts`                                  |
| View Transitions           |  111   | 144 |   18   | Newly 2025-10 | `document.startViewTransition`, `::view-transition-*` — `lifecycle/view-transitions.ts`, `base.css`                     |
| JSON modules               |  123   | 133 |  17.2  | Newly 2025-04 | `import … with { type: 'json' }` — frozen artefacts, `protocol/test-vectors.ts`                                         |
| `AbortSignal.timeout`      |  103   | 100 |   16   | Newly 2024-04 | transfer + resume deadlines — `domain/file-*.ts`                                                                        |
| `Promise.withResolvers`    |  119   | 121 |  17.4  | Newly 2024-03 | worker / lock coordination — `opfs-transfers.ts`, `domain/duplicate-tab.ts`, `file-*.ts`                                |
| Uint8Array base64/hex      |  140   | 133 |  18.2  | Newly 2025-09 | `toHex`/`fromHex`, `toBase64`/`fromBase64` — hex + base64url codecs, `shared/crypto/encoding.ts`                        |
| `@starting-style`          |  117   | 129 |  17.5  | Newly 2024-08 | + `transition-behavior: allow-discrete` — entry animations for mounted elements, `chat-view.css`, `composer.css`        |
| `text-wrap: balance`       |  114   | 121 |  17.5  | Newly 2024-05 | headings, taglines — `chat-view.css`, `landing-view.css`                                                                |
| `scrollbar-width: thin`    |  121   | 64  |  18.2  | Newly 2024-12 | message feed — `chat-view.css`                                                                                          |
| `scrollbar-gutter: stable` |   94   | 97  |  18.2  | Newly 2024-12 | message feed (no reflow on scrollbar) — `chat-view.css`                                                                 |

### Progressive enhancement

Standard base in every target engine; the listed API improves UX where present. Core function unaffected.

| Feature                     | Base (every engine)                     | Enhancement                                                              | Enhanced in                            | Where                     |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- | ------------------------- |
| File save                   | `<a download>` + `Blob`                 | `showSaveFilePicker` + `FileSystemWritableFileStream`                    | Chrome 86                              | `domain/file-download.ts` |
| Link share                  | `<a href>` + Clipboard `writeText`      | `navigator.share`                                                        | Safari 12.1, FF Android (✗ FF desktop) | `components/chat-view.ts` |
| Credential hygiene          | none needed                             | `PublicKeyCredential.signalUnknownCredential`                            | Chrome 132 (✗ FF, Safari buggy)        | `domain/passkey.ts`       |
| Composer suggestion opt-out | `spellcheck=false` + `autocomplete=off` | `writingsuggestions="false"` (suppresses OS/browser writing suggestions) | Chrome 124, Safari 18 (✗ FF)           | `components/chat-view.ts` |

### Cosmetic — degrades silently

Visual-only. Absence changes nothing functional.

| Feature               | Chrome | FF  | Safari | Where                                                                                     | Absent →                                                             |
| --------------------- | :----: | :-: | :----: | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `caret-shape: block`  |  144   |  ✗  |   ✗    | composer caret — `composer.css`                                                           | default caret                                                        |
| `text-wrap: pretty`   |  117   |  ✗  |   26   | chat messages, SAS caption, footer — `chat-view.css`, `sas-badge.css`, `landing-view.css` | last line not optimized                                              |
| `text-box: trim-both` |  133   |  ✗  |  18.2  | SAS caption gap — `sas-badge.css`                                                         | inherited line-height padding                                        |
| `scrollbar-color`     |  121   | 64  | 26.2\* | message feed — `chat-view.css`                                                            | default scrollbar (\*Safari: confirm at runtime)                     |
| `overflow-anchor`     |   56   | 66  |   ✗    | message feed — `chat-view.css`                                                            | value used is `auto` (default); ResizeObserver auto-scroll covers it |

## Awaiting platform support

Deliberate exceptions: used in a limited way or deferred pending engine support.

- **`field-sizing: content`** — ships in Firefox 152, not 151 (Chrome 123, Safari 26.2 have it); composer textarea has no auto-height on Firefox 151. `composer.css`.
- **`Temporal`** — absent in Bun 1.3.14 and Safari; `Date.toISOString()` meanwhile. `domain/clock.ts`.
- **Streaming SHA-256 in Web Crypto** — no engine exposes an incremental `digest`; `@noble/hashes` meanwhile.
- **WebTransport** — available in all three target browsers, but Bun 1.3.14 exposes no server-side WebTransport (HTTP/3) API; the relay stays on WebSocket. `transport/ws.ts`, `server/src/server.ts`.
- **Transferable `ReadableStream` in Safari** — Safari throws `DataCloneError`; until it ships, file transfer stays Chrome/Firefox only.
- **WebSocket + BFCache** — Chrome 149 and Safari 26.5 close the socket on cache entry; Firefox 151 treats an open WebSocket as a BFCache blocker and reloads instead of restoring. The `pageshow.persisted` guard force-terminates either way; no key survives.
