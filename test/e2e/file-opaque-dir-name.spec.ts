import { expect, test } from '@playwright/test';

import { openActiveRoom } from './fixtures/file-helpers.ts';

test('current session OPFS dir is opaque and the root contains no branded names', async ({
  browser,
}) => {
  const { aliceContext, bobContext, alice } = await openActiveRoom(browser);
  try {
    const probe = await alice.evaluate(async () => {
      const hook = (
        globalThis as unknown as {
          __unseenTest?: {
            fileState?: { currentOpaqueDir?: { value: string | undefined } };
          };
        }
      ).__unseenTest;
      const dir = hook?.fileState?.currentOpaqueDir?.value;
      const entries: string[] = [];
      const root = await navigator.storage.getDirectory();
      const iter = (root as unknown as { values: () => AsyncIterable<{ name: string }> }).values();
      for await (const entry of iter) {
        entries.push(entry.name);
      }
      return { dir, entries };
    });
    expect(probe.dir).toBeDefined();
    expect(probe.dir).toMatch(/^[\w-]{11}$/u);
    expect((probe.dir ?? '').toLowerCase()).not.toContain('transfer');
    expect((probe.dir ?? '').toLowerCase()).not.toContain('opfs');
    expect((probe.dir ?? '').toLowerCase()).not.toContain('unseen');
    expect((probe.dir ?? '').toLowerCase()).not.toContain('room');
    expect((probe.dir ?? '').toLowerCase()).not.toContain('file');
    expect(probe.entries).toContain(probe.dir);
    for (const name of probe.entries) {
      if (/^[\w-]{11}$/u.test(name)) {
        expect(name.toLowerCase()).not.toContain('unseen');
        expect(name.toLowerCase()).not.toContain('opfs');
        expect(name.toLowerCase()).not.toContain('transfer');
      }
    }
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
