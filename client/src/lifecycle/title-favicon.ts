const TITLE = 'peer@unseen ~ $ wait';

const reapply = (): void => {
  if (globalThis.document.title !== TITLE) {
    globalThis.document.title = TITLE;
  }
};

export const installTitleFaviconInvariant = (): void => {
  reapply();
  globalThis.document.addEventListener('visibilitychange', reapply);
  globalThis.addEventListener('pageshow', reapply);
};
