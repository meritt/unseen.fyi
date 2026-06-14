export class Signal<T> extends EventTarget {
  #value: T;

  constructor(initial: T) {
    super();
    this.#value = initial;
  }

  get value(): T {
    return this.#value;
  }

  set value(next: T) {
    if (Object.is(this.#value, next)) {
      return;
    }
    this.#value = next;
    this.dispatchEvent(new Event('change'));
  }

  subscribe(listener: () => void, options?: { signal?: AbortSignal }): () => void {
    this.addEventListener('change', listener, options);
    return (): void => {
      this.removeEventListener('change', listener);
    };
  }
}
