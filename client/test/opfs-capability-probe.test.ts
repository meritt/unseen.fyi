import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runOpfsCapabilityProbe } from '../src/storage/opfs-transfers.ts';

type GlobalShape = {
  Worker?: unknown;
  navigator?: unknown;
};

const globalShape = globalThis as GlobalShape;
const originalWorker = globalShape.Worker;
const originalNavigator = globalShape.navigator;

beforeEach(() => {
  globalShape.Worker = originalWorker;
  globalShape.navigator = originalNavigator;
});

afterEach(() => {
  globalShape.Worker = originalWorker;
  globalShape.navigator = originalNavigator;
});

describe('runOpfsCapabilityProbe — fallback paths', () => {
  test('returns false when Worker constructor is absent', async () => {
    globalShape.Worker = undefined;
    globalShape.navigator = {
      storage: { getDirectory: () => Promise.resolve({}) },
      locks: { request: () => Promise.resolve(undefined) },
    };

    const result = await runOpfsCapabilityProbe();

    expect(result).toBe(false);
  });

  test('returns false when navigator.storage is missing', async () => {
    globalShape.Worker = function () {
      throw new Error('should not be constructed');
    };
    globalShape.navigator = {
      locks: { request: () => Promise.resolve(undefined) },
    };

    const result = await runOpfsCapabilityProbe();

    expect(result).toBe(false);
  });

  test('returns false when the Worker constructor throws', async () => {
    globalShape.Worker = function () {
      throw new Error('blocked by CSP or sandbox');
    };
    globalShape.navigator = {
      storage: { getDirectory: () => Promise.resolve({}) },
      locks: { request: () => Promise.resolve(undefined) },
    };

    const result = await runOpfsCapabilityProbe();

    expect(result).toBe(false);
  });
});
