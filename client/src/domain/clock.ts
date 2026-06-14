export type Clock = {
  readonly nowIso: () => string;
};

export const browserClock: Clock = {
  nowIso: (): string => new Date().toISOString(),
};
