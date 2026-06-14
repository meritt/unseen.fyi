type Dict = {
  readonly landing: {
    readonly title: string;
    readonly tagline: string;
    readonly createButton: string;
    readonly signalEncrypted: string;
    readonly signalOneTime: string;
    readonly footerNote: string;
  };
  readonly chat: {
    readonly composerPlaceholder: string;
    readonly composerTooLong: string;
    readonly sendButton: string;
    readonly sasComparePrompt: string;
    readonly earlierRemoved: string;
    readonly newMessages: string;
    readonly system: {
      readonly waitingForPeer: string;
      readonly linkLabel: string;
      readonly copyLink: string;
      readonly sessionStarted: string;
      readonly peerDisconnected: string;
      readonly peerReconnected: string;
      readonly sessionEnded: string;
      readonly modeDowngradedToRam: string;
      readonly modeUpgradedLocally: string;
      readonly peerModeUpgraded: string;
      readonly modeUpgradeInvited: string;
      readonly modeUpgradeInvitedAction: string;
      readonly modeUpgradeDismissedByUser: string;
      readonly modeUpgradeFailed: string;
      readonly sessionHardened: string;
    };
    readonly placeholder: {
      readonly connecting: string;
      readonly resuming: string;
      readonly handshaking: string;
      readonly upgradingLocal: string;
      readonly rekeying: string;
      readonly reconnecting: string;
      readonly reconnectingIn: string;
      readonly sessionEnding: string;
    };
    readonly resumeLocked: {
      readonly title: string;
      readonly retry: string;
      readonly end: string;
    };
    readonly mode: {
      readonly statusRam: string;
      readonly statusPrf: string;
      readonly statusHardened: string;
    };
    readonly upgrade: {
      readonly button: string;
      readonly peerInvitedAccept: string;
      readonly peerInvitedDismiss: string;
    };
    readonly fileTransfer: {
      readonly attachAria: string;
      readonly removeAttachment: string;
      readonly initializing: string;
      readonly busyAnotherTransfer: string;
      readonly accept: string;
      readonly decline: string;
      readonly cancel: string;
      readonly downloadAria: string;
      readonly cancelled: string;
      readonly failed: { readonly sender: string; readonly receiver: string };
      readonly peerUnavailable: string;
      readonly unavailable: string;
      readonly sessionCapReached: string;
      readonly percent: string;
    };
  };
  readonly header: {
    readonly burn: string;
    readonly burnShort: string;
  };
  readonly panic: {
    readonly title: string;
    readonly body: string;
    readonly confirm: string;
    readonly cancel: string;
  };
  readonly langToggle: {
    readonly label: string;
    readonly en: string;
    readonly ru: string;
    readonly enName: string;
    readonly ruName: string;
  };
  readonly errors: {
    readonly duplicateTab: string;
  };
  readonly md: {
    readonly tooComplex: string;
  };
  readonly time: {
    readonly justNow: string;
  };
};

export const en: Dict = {
  landing: {
    title: 'unseen',
    tagline: 'Private one-on-one chat that disappears.',
    createButton: 'Create a private room',
    signalEncrypted: 'End-to-end encrypted',
    signalOneTime: 'One-time private session',
    footerNote: 'No sign-ups. No data stored. Just you and one other person.',
  },
  chat: {
    composerPlaceholder: 'Type a message',
    composerTooLong: 'Message too long',
    sendButton: 'Send',
    sasComparePrompt: 'Compare these emojis to make sure you’re talking to the right person.',
    earlierRemoved: 'Earlier messages removed.',
    newMessages: '{count} new ↓',
    system: {
      waitingForPeer: 'Waiting for the other person to join by [link].',
      linkLabel: 'link',
      copyLink: 'Copy',
      sessionStarted: 'Session started. Messages disappear after this session.',
      peerDisconnected: 'The other person disconnected',
      peerReconnected: 'The other person is back',
      sessionEnded: 'Session ended',
      modeDowngradedToRam: 'Continuing without a passkey — messages will be lost on refresh.',
      modeUpgradedLocally: 'Your side of the session is now protected.',
      peerModeUpgraded: 'The other person protected their side of the session.',
      modeUpgradeInvited: 'Peer protected their side. [action].',
      modeUpgradeInvitedAction: 'Protect yours',
      modeUpgradeDismissedByUser: 'Protect-session prompt dismissed.',
      modeUpgradeFailed: 'Could not protect the session. Stayed in current mode.',
      sessionHardened: 'Session strengthened.',
    },
    placeholder: {
      connecting: 'Connecting…',
      resuming: 'Restoring session…',
      handshaking: 'Securing channel…',
      upgradingLocal: 'Setting up passkey…',
      rekeying: 'Strengthening session…',
      reconnecting: 'Reconnecting…',
      reconnectingIn: 'Reconnecting in {seconds} s…',
      sessionEnding: 'Session ending…',
    },
    resumeLocked: {
      title: 'Session is locked. Confirm your passkey to continue.',
      retry: 'Confirm passkey',
      end: 'End session',
    },
    mode: {
      statusRam: 'History lives in this tab only',
      statusPrf: 'This tab survives reload',
      statusHardened: 'Session strengthened',
    },
    upgrade: {
      button: 'Protect session',
      peerInvitedAccept: 'Protect',
      peerInvitedDismiss: 'Not now',
    },
    fileTransfer: {
      attachAria: 'Attach a file',
      removeAttachment: 'Remove',
      initializing: 'Preparing…',
      busyAnotherTransfer: 'Another transfer in progress',
      accept: 'Accept',
      decline: 'Decline',
      cancel: 'Cancel',
      downloadAria: 'Download {name}',
      cancelled: 'Transfer cancelled',
      failed: {
        sender: 'Could not send file. Try again.',
        receiver: 'Could not receive file.',
      },
      peerUnavailable: 'Peer can’t receive files',
      unavailable: 'File no longer available',
      sessionCapReached: 'File transfer limit reached for this session.',
      percent: '{percent}%',
    },
  },
  header: {
    burn: 'Burn session',
    burnShort: 'Burn',
  },
  panic: {
    title: 'Destroy this session',
    body: 'This closes the connection and erases all keys. Recovery is impossible. Continue?',
    confirm: 'Burn',
    cancel: 'Cancel',
  },
  langToggle: {
    label: 'Language',
    en: 'EN',
    ru: 'RU',
    enName: 'English',
    ruName: 'Русский',
  },
  errors: {
    duplicateTab: 'This session is already open in another tab.',
  },
  md: {
    tooComplex: 'too complex to render',
  },
  time: {
    justNow: 'just now',
  },
};

export type { Dict };
