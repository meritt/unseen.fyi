# Platform baseline

Web-platform features Unseen depends on that are not yet Widely available - capabilities adopted early and tracked toward interop - plus what we await. No fallbacks, no polyfills.

Targets: Chrome 153 · Firefox 155 · Safari 26.6 · Bun 1.4.2.
Support verified 2026-09-12.

Playwright 1.63.0 bundles Chromium 153, Firefox 155 and WebKit 26.6, so `test:e2e` runs at the stated floor on every engine.

## Client

Every row ships in all three target engines; _Limited_ marks Baseline's label, not a support gap.

| Capability                 | Chrome | FF  | Safari | Baseline             | API / where                                                                                                             |
| -------------------------- | :----: | :-: | :----: | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| CSS anchor positioning     |  131   | 147 |   26   | Limited              | `anchor-name`, `position-anchor`, `anchor()`, `anchor-scope` - tooltip pills, `utilities.css`                           |
| WebAuthn PRF               |  116   | 139 |   18   | no entry (WebAuthn)  | `credentials.create/get({extensions:{prf}})` on a platform authenticator - opt-in PRF mode, `domain/passkey.ts`         |
| Trusted Types              |   83   | 148 |   26   | Newly 2026-02        | `require-trusted-types-for 'script'` CSP, `trustedTypes.createPolicy` - `static/headers.ts`, `workers/create-worker.ts` |
| X25519 ECDH                |  133   | 130 |   17   | no entry (WebCrypto) | `crypto.subtle` `deriveBits({name:'X25519'})` - `shared/crypto/x25519.ts`                                               |
| Navigation API             |  102   | 147 |  26.2  | Newly 2026-01        | `navigation.navigate('/', { history: 'replace' })` - invalid-route redirect, `main.ts`                                  |
| View Transitions           |  111   | 144 |   18   | Newly 2025-10        | `document.startViewTransition`, `::view-transition-*` - `lifecycle/view-transitions.ts`, `base.css`                     |
| JSON modules               |  123   | 138 |  17.2  | Newly 2025-04        | `import … with { type: 'json' }` - frozen artefacts, `protocol/test-vectors.ts`                                         |
| `field-sizing: content`    |  123   | 152 |  26.2  | Newly 2026-06        | composer textarea auto-height in one declaration - `composer.css`                                                       |
| `text-box: trim-both`      |  133   | 154 |  18.2  | Newly 2026-08        | SAS caption gap - `sas-badge.css`                                                                                       |
| `AbortSignal.timeout`      |  103   | 100 |   16   | Newly 2024-04        | offer, verify and probe deadlines - `domain/file-send.ts`, `storage/opfs-transfers.ts`                                  |
| `Promise.withResolvers`    |  119   | 121 |  17.4  | Newly 2024-03        | worker / lock coordination - `opfs-transfers.ts`, `domain/duplicate-tab.ts`, `file-*.ts`                                |
| Uint8Array base64/hex      |  140   | 133 |  18.2  | Newly 2025-09        | `toHex`/`fromHex`, `toBase64`/`fromBase64` - hex + base64url codecs, `shared/crypto/encoding.ts`                        |
| `@starting-style`          |  117   | 129 |  17.5  | Newly 2024-08        | entry animations for mounted elements - `chat-view.css`, `composer.css`                                                 |
| `text-wrap: balance`       |  114   | 121 |  17.5  | Newly 2024-05        | headings, taglines - `chat-view.css`, `landing-view.css`                                                                |
| `scrollbar-width: thin`    |  121   | 64  |  18.2  | Newly 2024-12        | message feed - `chat-view.css`                                                                                          |
| `scrollbar-gutter: stable` |   94   | 97  |  18.2  | Newly 2024-12        | message feed (no reflow on scrollbar) - `chat-view.css`                                                                 |

Two rows carry no Baseline entry of their own: the WebAuthn PRF extension rolls into `webauthn` (Widely since 2021) and X25519 into `web-cryptography` (Widely), so the per-engine columns are the only support signal for them.

The PRF Safari column is the weakest claim here: browser-compat-data records `create()` support from 18 but no `get()` support, while WebKit's own tracker closed the assertion-side bug in January 2026. Our PRF e2e specs are pinned to Chromium, so Safari PRF is **unverified by our suite** - confirm at runtime before relying on it.

`position-anchor` is the one part of anchor positioning that lags: Chrome 151, Firefox 151, and Safari 27 for the `normal` initial value (Safari 26.x initialises it to `auto`). `utilities.css` sets `position-anchor` explicitly, so the difference does not reach us.

### Progressive enhancement

Standard base in every target engine; the listed API improves UX where present. Core function unaffected.

| Feature                     | Base (every engine)                     | Enhancement                                   | Enhanced in                            | Where                     |
| --------------------------- | --------------------------------------- | --------------------------------------------- | -------------------------------------- | ------------------------- |
| File save                   | `<a download>` + `Blob`                 | `showSaveFilePicker` + writable stream        | Chrome 86                              | `domain/file-download.ts` |
| Link share                  | `<a href>` + Clipboard `writeText`      | `navigator.share`                             | Safari 12.1, FF Android (✗ FF desktop) | `components/chat-view.ts` |
| Credential hygiene          | none needed                             | `PublicKeyCredential.signalUnknownCredential` | Chrome 132, Safari 26 (✗ FF)           | `domain/passkey.ts`       |
| Composer suggestion opt-out | `spellcheck=false` + `autocomplete=off` | `writingsuggestions="false"`                  | Chrome 124, Safari 18 (✗ FF)           | `components/chat-view.ts` |

`navigator.share` stays behind `dom.webshare.enabled` in every Firefox desktop release build, so the clipboard path is the one Firefox users get.

### Cosmetic - degrades silently

Visual-only. Absence changes nothing functional.

| Feature              | Chrome | FF  | Safari | Where                                                                                     | Absent →                                                             |
| -------------------- | :----: | :-: | :----: | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `caret-shape: block` |  144   |  ✗  |   ✗    | composer caret - `composer.css`                                                           | default caret                                                        |
| `text-wrap: pretty`  |  117   |  ✗  |   26   | chat messages, SAS caption, footer - `chat-view.css`, `sas-badge.css`, `landing-view.css` | last line not optimized                                              |
| `scrollbar-color`    |  121   | 64  |  26.2  | message feed - `chat-view.css`                                                            | default scrollbar                                                    |
| `overflow-anchor`    |   56   | 66  |   ✗    | message feed - `chat-view.css`                                                            | value used is `auto` (default); ResizeObserver auto-scroll covers it |

`overflow-anchor` is announced for Safari 27; no released Safari has it.

## Awaiting platform support

Deliberate exceptions: used in a limited way or deferred pending engine support.

- **`Temporal`** - Chrome 144, Firefox 139, **no released Safari**. It reached Safari Technology Preview 249 on 2026-07-29, after the Safari 27 beta branch, and Safari 27 does not ship it; compat data still records Safari as preview-only. `Date.toISOString()` meanwhile. Bun 1.4.2 has it, which is why the ban on `Date` in client code is worth keeping. `domain/clock.ts`.
- **Streaming SHA-256 in Web Crypto** - no engine exposes an incremental `digest`, and no specification defines one: `w3c/webcrypto#73` has been open since 2016, and the live proposal (an async-iterable `digest`) is unmerged. `DigestStream` is a non-standard runtime extension, never a web API. `@noble/hashes` meanwhile.
- **WebTransport** - available in all three target browsers, but Bun 1.4.2 exposes no server-side WebTransport (HTTP/3) API and `server.upgrade()` is HTTP/1.1 only; the relay stays on WebSocket. `transport/ws.ts`, `server/src/server.ts`.
- **Transferable `ReadableStream` in Safari** - Safari throws `DataCloneError` through 26.6; it landed in Technology Preview 238 and is announced for Safari 27. Until it ships, file transfer stays Chrome/Firefox only.
- **WebSocket + BFCache** - Chrome (since 149) and Safari close the socket on cache entry and fire `error` then `close` on restore; Firefox 155 still treats an open WebSocket as a BFCache blocker and reloads instead. The `pageshow.persisted` guard force-terminates either way; no key survives.
- **`scheduler.postTask` / `scheduler.yield`** - Chrome 94/129 and Firefox 142, no Safari. Not used for core logic.
- **Interest invokers (`interestfor`)** - Chrome 142 only. Unlike the CSS rows above this is not safe as progressive enhancement: with no implementation the interaction never fires at all.
- **`interpolate-size` / `calc-size()`** - Chrome 129 only. Acceptable as pure-CSS progressive enhancement, since an unsupported declaration is simply dropped.
- **Explicit Resource Management (`using` / `await using`, `Symbol.dispose`, `DisposableStack`)** - Chrome 134, Firefox 141, no released Safari. The OPFS access handles, the probe worker and the Web Locks would all read better as disposables; until Safari ships, `try` / `finally` stays.
- **`CloseWatcher`** - Chrome 126, Firefox 149, no released Safari.
- **`crypto.subtle.supports()`** - no engine has it (the spec is still a WICG draft), so capability probing stays `try` / `catch`.
- **WebCrypto post-quantum (ML-KEM, ML-DSA)** - shipping in Chrome 154, in beta since 2026-09-02; Firefox has the KEM methods in preview only, and both Mozilla and WebKit hold a neutral standards position. Revisit when two engines commit.
- **Prioritized task scheduling** - no released Safari has `scheduler.*`, `requestIdleCallback` or `element.moveBefore()`, so the platform offers no such primitive at this floor, even though Chrome and Firefox ship all three.
