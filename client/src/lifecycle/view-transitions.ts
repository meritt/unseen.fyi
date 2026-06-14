import { sessionState } from '../state/session-state.ts';

const SKIP_STATES = new Set(['FATAL_ENDING', 'TERMINATED']);

export const runStateTransition = (updateDom: () => void): void => {
  if (SKIP_STATES.has(sessionState.value)) {
    updateDom();
    return;
  }
  const transition = globalThis.document.startViewTransition(updateDom);
  void Promise.allSettled([transition.ready, transition.finished]);
};
