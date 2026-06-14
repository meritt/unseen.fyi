import { clearMessages } from '../state/message-log.ts';
import { sessionState } from '../state/session-state.ts';
import { sweepAllOpaqueDirsForBfcache } from '../storage/opfs-transfers.ts';

const TERMINAL_STATES = new Set(['IDLE', 'TERMINATED']);

export const installBFCacheGuard = (): void => {
  globalThis.addEventListener('pageshow', (event: PageTransitionEvent) => {
    if (!event.persisted) {
      return;
    }
    if (TERMINAL_STATES.has(sessionState.value)) {
      return;
    }
    void sweepAllOpaqueDirsForBfcache();
    clearMessages();
    sessionState.value = 'TERMINATED';
  });
};
