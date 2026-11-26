// Safe wrapper around bobby-hands: if the native module is missing (e.g. a build without it),
// the app still runs and the settings screen says so, instead of crashing on import.
import type { HandsStatus, SettingsPage, UnlockStatus } from 'bobby-hands';

type HandsApi = typeof import('bobby-hands');

let api: Partial<HandsApi> | null = null;
let loadError = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  api = require('bobby-hands') as HandsApi;
} catch (e) {
  loadError = String(e);
}

export const handsMissing = (): string => (api ? '' : loadError || 'bobby-hands not loaded');

function call<T>(name: keyof HandsApi, fallback: T, ...args: unknown[]): T {
  const fn = api?.[name] as unknown;
  if (typeof fn !== 'function') return fallback;
  try {
    return (fn as (...a: unknown[]) => T)(...args);
  } catch (e) {
    console.warn(`bobby-hands ${String(name)} failed: ${String(e)}`);
    return fallback;
  }
}

export const emptyStatus: HandsStatus = {
  accessibility: false,
  serviceRunning: false,
  notificationAccess: false,
  notifications: false,
  microphone: false,
  hubRunning: false,
  tokenSet: false,
  keepAlive: false,
  peers: { hands: false, mind: false, mouth: false, caller: false, watch: 0 },
};

export const emptyUnlock: UnlockStatus = {
  setUp: false,
  armed: false,
  earbuds: '',
  earbudsConnected: false,
  disarmedReason: '',
  lastResult: '',
  lastAt: 0,
  secureLockSet: false,
};

const noSub = { remove() {} };

export const hands = {
  configure: (token: string) => call('configure', undefined, { token }),
  status: (): HandsStatus => call('status', emptyStatus),
  openSettings: (which: SettingsPage) => call('openSettings', undefined, which),
  moveToBack: (): boolean => call('moveToBack', false),
  startKeepAlive: (text?: string) => call('startKeepAlive', undefined, text),
  stopKeepAlive: () => call('stopKeepAlive', undefined),
  openedFromNotification: (): boolean => call('openedFromNotification', false),
  clearOpenedFromNotification: () => call('clearOpenedFromNotification', undefined),
  unlockStatus: (): UnlockStatus => call('unlockStatus', emptyUnlock),
  openUnlockSetup: () => call('openUnlockSetup', undefined),
  turnOffUnlock: () => call('turnOffUnlock', undefined),
  addAssistListener: (fn: (e: { locked: boolean }) => void): { remove(): void } =>
    call('addAssistListener', noSub, fn),
};
