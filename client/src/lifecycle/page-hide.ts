type PageHideListener = () => void;

let pageHiding = false;
const listeners = new Set<PageHideListener>();

export const isPageHiding = (): boolean => pageHiding;

export const onPageHide = (listener: PageHideListener): (() => void) => {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
};

export const installPageHideTracker = (): void => {
  const markHiding = (): void => {
    pageHiding = true;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* skip failing listener */
      }
    }
  };
  globalThis.addEventListener('beforeunload', markHiding);
  globalThis.addEventListener('pagehide', markHiding);
  globalThis.addEventListener('pageshow', () => {
    pageHiding = false;
  });
};
