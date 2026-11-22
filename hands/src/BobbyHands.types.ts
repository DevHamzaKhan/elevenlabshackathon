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
