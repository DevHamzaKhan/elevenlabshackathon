/** Which permission page `openSettings` should open. */
export type SettingsPage =
  | 'accessibility'
  | 'notificationAccess'
  | 'notifications'
  | 'microphone'
  | 'app';

export type Peers = {
  hands: boolean;
  mind: boolean;
  mouth: boolean;
  caller: boolean;
  /** Number of connected watch clients. */
  watch: number;
};

export type HandsStatus = {
  /** The Hands accessibility service is switched on in Android settings. */
  accessibility: boolean;
  /** The service is switched on and running right now (the hub only runs then). */
  serviceRunning: boolean;
  /** Notification access (the notification listener) is granted. */
  notificationAccess: boolean;
  /** The app may post notifications (POST_NOTIFICATIONS). */
  notifications: boolean;
  /** Microphone permission (RECORD_AUDIO) is granted. */
  microphone: boolean;
  /** The hub is listening on 127.0.0.1:8765. */
  hubRunning: boolean;
  /** Whether a hub token has been configured. */
  tokenSet: boolean;
  /** The keep-alive foreground service is running. */
  keepAlive: boolean;
  peers: Peers;
};

/** Bobby's locked-phone unlock (see hands/README.md "Locked-phone unlock"). Never any secret. */
export type UnlockStatus = {
  /** A PIN, phrase and earbuds are stored. */
  setUp: boolean;
  /** Set up and not disarmed by a failed attempt. */
  armed: boolean;
  /** Name of the trusted earbuds. */
  earbuds: string;
  /** The trusted earbuds are connected right now. */
  earbudsConnected: boolean;
  /** Why it disarmed (empty when armed). */
  disarmedReason: string;
  /** The latest outcome, e.g. "unlocked", "skipped: no_earbuds". */
  lastResult: string;
  /** When that was (ms since epoch). */
  lastAt: number;
  /** The phone has a PIN, pattern or password lock (the feature needs a PIN). */
  secureLockSet: boolean;
};

export type BobbyHandsEvents = {
  /** The side button was held on a locked phone with the unlock armed: wake Bobby. */
  onAssist: (e: { locked: boolean }) => void;
};
