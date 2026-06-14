import type { Bytes } from '@unseen/shared/crypto/encoding.ts';

import type { ChatView } from './components/chat-view.ts';
import './components/landing-view.ts';
import {
  attachmentMap,
  fileTransferReady,
  fileTransferSupported,
  incomingActive,
  sessionReceivedBytes,
  transferActive,
} from './domain/file-state.ts';
import { installBFCacheGuard } from './lifecycle/bfcache.ts';
import { installPageHideTracker } from './lifecycle/page-hide.ts';
import { installTitleFaviconInvariant } from './lifecycle/title-favicon.ts';
import { parseLocation, type Route } from './routing/router.ts';
import {
  appendFileMessage,
  appendMessage,
  appendSystemMessage,
  clearMessages,
} from './state/message-log.ts';
import { sessionState } from './state/session-state.ts';
import { currentOpaqueDir, OPFS_LOCK_NAME } from './storage/opfs-transfers.ts';

declare const __UNSEEN_DEV__: boolean;

installTitleFaviconInvariant();
installPageHideTracker();
installBFCacheGuard();

const VIEW_TAG = {
  landing: 'landing-view',
  chat: 'chat-view',
} as const satisfies Record<Exclude<Route['kind'], 'invalid'>, string>;

const bytesEqual = (a: Bytes | undefined, b: Bytes): boolean => {
  if (a === undefined || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
};

type ChatViewModule = { readonly ChatView: new () => ChatView };
let chatModule: ChatViewModule | undefined;
const loadChatView = async (): Promise<ChatViewModule> => {
  chatModule ??= await import('./components/chat-view.ts');
  return chatModule;
};

const mountForRoute = async (): Promise<void> => {
  const route = parseLocation(globalThis.location);
  if (route.kind === 'invalid') {
    globalThis.navigation.navigate('/', { history: 'replace' });
    return;
  }
  const root = globalThis.document.body;

  if (route.kind === 'chat') {
    // define the chat element before creating it, or the `.secret` setter is missing
    const { ChatView } = await loadChatView();
    const current = root.firstElementChild;
    if (current instanceof ChatView) {
      if (!bytesEqual(current.secret, route.secret)) {
        current.secret = route.secret;
      }
      return;
    }
    const next = globalThis.document.createElement(VIEW_TAG.chat);
    if (next instanceof ChatView) {
      next.secret = route.secret;
    }
    root.replaceChildren(next);
    return;
  }

  const current = root.firstElementChild;
  if (current?.tagName.toLowerCase() !== VIEW_TAG.landing) {
    root.replaceChildren(globalThis.document.createElement(VIEW_TAG.landing));
  }
};

globalThis.addEventListener('hashchange', () => void mountForRoute());
globalThis.addEventListener('popstate', () => void mountForRoute());
void mountForRoute();

if (__UNSEEN_DEV__) {
  Object.assign(globalThis, {
    __unseenTest: {
      appendMessage,
      appendFileMessage,
      appendSystemMessage,
      clearMessages,
      sessionState,
      fileState: {
        fileTransferSupported,
        fileTransferReady,
        transferActive,
        incomingActive,
        attachmentMap,
        currentOpaqueDir,
        OPFS_LOCK_NAME,
        sessionReceivedBytes,
      },
    },
  });
}
