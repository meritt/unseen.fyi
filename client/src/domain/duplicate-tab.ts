export type RoomClaim = {
  readonly release: () => void;
};

export const claimRoom = async (lockKey: string): Promise<RoomClaim | null> => {
  const { promise: claimPromise, resolve: resolveClaim } =
    Promise.withResolvers<RoomClaim | null>();
  void navigator.locks.request(lockKey, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (lock === null) {
      resolveClaim(null);
      return;
    }
    const { promise: heldPromise, resolve: resolveHeld } = Promise.withResolvers<undefined>();
    resolveClaim({ release: resolveHeld.bind(null, undefined) });
    await heldPromise;
  });
  return await claimPromise;
};
