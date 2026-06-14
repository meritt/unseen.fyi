import { defineConfig, devices } from '@playwright/test';

const CLIENT_PORT = 5173;
const SERVER_PORT = 3001;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL: `http://localhost:${String(CLIENT_PORT)}`,
    trace: 'retain-on-failure',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testIgnore: [
        // no Firefox CDP virtual authenticator
        '**/prf-mode.spec.ts',
        '**/resume.spec.ts',
        '**/no-storage-wipe-on-unload.spec.ts',
        '**/webauthn-mocks.spec.ts',
        '**/mode-toggle.spec.ts',
        // browser-agnostic, run once on Chromium
        '**/sri.spec.ts',
        '**/file-csp-worker-src-no-blob.spec.ts',
        // Firefox drops document.cookie on unload
        '**/unload-cookie-survival.spec.ts',
        // signalUnknownCredential not in Firefox
        '**/file-burn-ordering.spec.ts',
        // self-skip on Firefox via in-spec guards
        '**/file-burn-bounded-timeout.spec.ts',
        '**/file-reconnect-cancels-transfer.spec.ts',
        '**/file-network-blip-session-survives.spec.ts',
        '**/file-bfcache-restore-cleans-opfs.spec.ts',
        '**/file-a11y.spec.ts',
      ],
    },
    {
      name: 'webkit',
      // WebKit has no OPFS createSyncAccessHandle in workers; file transfer is probe-gated off, so transfer specs cannot reach ready
      use: { ...devices['Desktop Safari'] },
      testIgnore: [
        '**/prf-mode.spec.ts',
        '**/resume.spec.ts',
        '**/sri.spec.ts',
        '**/no-storage-wipe-on-unload.spec.ts',
        '**/unload-cookie-survival.spec.ts',
        '**/bfcache.spec.ts',
        '**/webauthn-mocks.spec.ts',
        '**/mode-toggle.spec.ts',
        '**/adversarial.spec.ts',
        '**/file-receiver-decline.spec.ts',
        '**/file-receiver-cancel.spec.ts',
        '**/file-too-large.spec.ts',
        '**/file-concurrent-rejected.spec.ts',
        '**/file-opaque-dir-name.spec.ts',
        '**/file-opaque-lock-name.spec.ts',
        '**/file-orphan-sweep.spec.ts',
        '**/file-text-interleave.spec.ts',
        '**/file-large-download.spec.ts',
        '**/file-hash-mismatch.spec.ts',
        '**/file-opfs-evicted.spec.ts',
        '**/file-back-to-back-transfers.spec.ts',
        '**/file-cascade-replay.spec.ts',
        '**/file-text-interleave-sender.spec.ts',
        '**/file-session-receive-cap.spec.ts',
        '**/file-pagehide-no-storage-write.spec.ts',
        '**/file-blob-not-materialised.spec.ts',
        '**/file-csp-worker-src-no-blob.spec.ts',
        '**/file-burn-ordering.spec.ts',
        '**/file-burn-bounded-timeout.spec.ts',
        '**/file-reconnect-cancels-transfer.spec.ts',
        '**/file-network-blip-session-survives.spec.ts',
        '**/file-bfcache-restore-cleans-opfs.spec.ts',
        '**/file-a11y.spec.ts',
      ],
    },
  ],
  webServer: [
    {
      command: 'bun run dev:server',
      port: SERVER_PORT,
      reuseExistingServer: false,
      timeout: 10_000,
      env: {
        UNSEEN_ALLOWED_ORIGINS: `http://localhost:${String(CLIENT_PORT)}`,
        UNSEEN_RL_CONNECT_LIMIT: '1000',
        UNSEEN_RL_NEWROOM_LIMIT: '1000',
        UNSEEN_RL_JOINROOM_LIMIT: '1000',
        UNSEEN_GRACE_MS: '5000',
        UNSEEN_SWEEP_MS: '1000',
      },
    },
    {
      command: 'bun run dev:client',
      port: CLIENT_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
