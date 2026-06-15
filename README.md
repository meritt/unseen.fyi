# Unseen

End-to-end encrypted, ephemeral, one-on-one web chat. Two browsers derive a shared key from a 256-bit secret carried in the URL fragment; a `Bun.serve` relay forwards opaque ciphertext between them byte-for-byte, never decrypting. No accounts, no database, no server-side identity, no message history.

## A platform showcase

Unseen exists to answer one question: how far does the **native web platform** reach today, on its own, for a real and security-critical app?

So the constraints are deliberate. One UI dependency (`lit`, for declarative rendering) and one narrow crypto dependency (`@noble/hashes`, only because Web Crypto's `subtle.digest` is one-shot and streaming file integrity needs an incremental SHA-256). Everything else is the platform: Web Crypto, WebAuthn, OPFS, Web Locks, the Navigation and View Transitions APIs, module Workers, and modern CSS. No framework, no polyfills, no transpilation to legacy targets, no compatibility shims.

It targets the current release of each engine: **Chrome 149, Firefox 151, Safari 26.5**. Many of the APIs below did not exist, or were not interoperable across all three, a year ago. That is the point.

## Status and intended use

Unseen is a technical demonstration, not a product. It is provided **as is, without warranty**, for evaluation and educational purposes, and may change or be taken down at any time. Do not rely on it for communications where loss or unavailability would cause harm. It **must not be used for unlawful purposes**.

The design retains as little as possible. The relay holds no database, no accounts, and no message history; it forwards opaque ciphertext that it cannot read. The site sets no cookies and runs no analytics. The source is public and may be self-hosted, and anyone who deploys an instance is responsible for operating it lawfully. Security issues can be reported as described in [`SECURITY.md`](SECURITY.md).

## Web platform capabilities

**Identity and cryptography**

- **Web Crypto X25519** (`crypto.subtle.generateKey({ name: 'X25519' })` + `deriveBits`): ephemeral ECDH key agreement for the initial session key and for every PRF-mode rekey. No userland curve implementation.
- **AES-256-GCM, AES-KW, HKDF-SHA256** via `crypto.subtle`: per-message AEAD, session-key wrapping, and the key schedule that derives every subkey from the 32-byte URL secret.
- **WebAuthn PRF extension** (`prf: { eval: { first } }` → `getClientExtensionResults().prf`): turns a per-room passkey into a symmetric wrap key, so a session can survive a reload without ever writing raw key bytes to disk.
- **`PublicKeyCredential.signalUnknownCredential()`**: tells the platform credential manager to forget the per-room passkey the instant a session is burned.
- **`isUserVerifyingPlatformAuthenticatorAvailable()`**: capability probe that decides whether the opt-in upgrade affordance is shown at all.

**Storage and files**

- **OPFS** (`navigator.storage.getDirectory`) with **`createSyncAccessHandle`** inside a dedicated Worker: synchronous chunk I/O streams files up to 100 MiB without buffering them in the main thread. The directory name is HKDF-derived and swept on every boot.
- **`sessionStorage` as the only persistence**: a single tab-bound, AES-KW-wrapped session key under an opaque HKDF-derived key name. Nothing else is written; `localStorage` holds only the language preference.

**Coordination and lifecycle**

- **Web Locks** (`navigator.locks`): a room-scoped lock is the duplicate-tab guard. A second tab on the same room is refused rather than silently racing.
- **Navigation API** (`navigation.navigate`): a same-document replace redirect sends any invalid route back to the landing page — no server round-trip, no distinguishable error view.
- **BFCache-aware lifecycle** (`pagehide` / `pageshow` with `persisted`): forces a clean terminate on restore, so a back/forward navigation can never resurrect a stale key.
- **Module Workers** (`new Worker(url, { type: 'module' })`): markdown parsing, the OPFS probe and boot-sweep, and both file-transfer pipelines run off the main thread.
- **`AbortSignal.timeout()`**: declarative timeouts across the transport and worker handshakes.

**Interface and CSS**

- **View Transitions** (`document.startViewTransition`, `::view-transition-*`): animated state changes, with an explicit skip-list for transitions that must never animate.
- **CSS anchor positioning** (`anchor-name`, `anchor()`, `position-anchor`): tooltips are positioned natively against their trigger. No JS measurement, no positioning library.
- **`field-sizing: content`**: the composer textarea autosizes to its content in one CSS line.
- **`oklch()` color, `color-mix()`, `:has()`, `text-wrap: balance / pretty`, cascade `@layer`**: the entire design system is modern CSS with no preprocessor.
- **Web Components via `lit`**: every view is a custom element.

Per-engine support for every capability above — and the few deliberate exceptions (Firefox 151 `field-sizing`, server-side WebTransport, and more) — is tracked in [`BASELINE.md`](BASELINE.md).

## Design principles

- **Native first, no fallbacks.** If a feature isn't in the current release of all three engines, it isn't used — no polyfills, no legacy bundle.
- **Opaque relay.** The server sees connection metadata and fixed-layout frame headers, never a key or a byte of plaintext. RELAY frames are forwarded byte-for-byte.
- **Ephemeral by default.** No database; closing the tab ends the session. Surviving a reload or a network blip is opt-in, through the WebAuthn PRF upgrade.
- **Two-tier security.** Sessions start RAM-only: the session key lives only in the JS heap and nothing is persisted. Users opt in to PRF mode through a per-room passkey for reload survivability; when both peers reach PRF, a coordinated X25519 rekey inside the encrypted channel swaps in a non-extractable key.
- **Out-of-band verification.** A 5-emoji SAS derived from the session key is the only defence against an active MITM; peers compare it over a second channel.

## Architecture highlights

- HKDF-SHA256 splits the 32-byte URL secret into seven derived values; the relay only ever learns `room_id`.
- All frames are fixed-layout `ArrayBuffer`s, at most 8 736 bytes. Each RELAY frame carries a one-byte `kind` discriminator bound into the AES-GCM AAD, so on-wire tampering fails authentication.
- Send counters are persisted to `sessionStorage` _before_ encryption (with a block-of-64 reservation for file-chunk bursts); the receive side enforces strict `recv + 1`, with a single first-frame gap permitted on resume. A counter never rolls back, which makes `(session_key, nonce)` reuse impossible.

## Project layout

```
shared/   Cross-workspace primitives: wire codec, crypto, frozen test vectors
client/   Lit SPA, Web Workers, OPFS, build.ts, dev-server.ts
server/   Bun.serve relay, room registry, rate limiting, metrics, static serving
test/     e2e/ (Playwright cross-browser), perf/ (Lighthouse + gzip budgets)
```

Each workspace has its own `package.json` and `tsconfig.json` extending `tsconfig.core.json`. Type-checking is `tsgo` (TypeScript 7); linting and formatting are `oxlint` and `oxfmt`.

## Local development

Bun 1.3.14. Run `bun install`, then:

```bash
bun run dev:server          # WS + static on :3001
bun run dev:client          # rebuild-on-save dev server on :5173
bun run test                # bun:test across shared / client / server
bun run test:e2e            # Playwright on chromium + firefox + webkit
bun run lint                # oxlint --type-aware
bun run format              # oxfmt
bun run typecheck           # tsgo --noEmit per workspace
bun run perf:bundle-size    # gzip budget gate (96 KB JS, 10 KB CSS)
bun run perf:lighthouse     # LCP / TBT / CLS budgets via headless Chrome
```

## Documentation

The full specification lives under `docs/`:

| File             | Contents                                                                   |
| ---------------- | -------------------------------------------------------------------------- |
| `01-overview.md` | goals, non-goals, threat model, architecture, session state machine        |
| `02-protocol.md` | crypto primitives, wire format, handshake, SAS, resume, rekey, error codes |
| `03-client.md`   | UI, FSM, lifecycle, storage, i18n, markdown, file-transfer UI              |
| `04-server.md`   | Bun.serve, registry, cleanup, rate-limit, headers, metrics                 |

Frozen protocol artefacts (the SAS pool and test vectors) live in `shared/src/protocol/` and are pinned by SHA-256 in `shared/src/protocol/freeze.ts`; any change invalidates the protocol-freeze suite and signals a version bump.
