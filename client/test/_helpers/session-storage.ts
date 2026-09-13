class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

type Holder = { sessionStorage?: unknown };

export const installSessionStorage = (): (() => void) => {
  const holder = globalThis as Holder;
  const original = holder.sessionStorage;
  holder.sessionStorage = new MemoryStorage();
  return (): void => {
    holder.sessionStorage = original;
  };
};
