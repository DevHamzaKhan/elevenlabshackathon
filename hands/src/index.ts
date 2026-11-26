import Native from './BobbyHandsModule';
import type { HandsStatus, SettingsPage, UnlockStatus } from './BobbyHands.types';

export * from './BobbyHands.types';

/** Sets the hub's token. Stored on the phone, so it survives restarts. */
export function configure(options: { token: string }): void {
  Native.configure(options);
}

/** Which permissions are granted and who is connected to the hub. */
export function status(): HandsStatus {
  return Native.status();
}

/** Opens the Android settings page for a missing permission. */
export function openSettings(which: SettingsPage): void {
  Native.openSettings(which);
}

/** Sends the app to the back, so whatever was on screen before shows again. */
export function moveToBack(): boolean {
  return Native.moveToBack();
}

/**
 * Starts a foreground service with a notification, so the app keeps running while other apps
 * are on screen. Call when Bobby wakes. Uses the microphone type when RECORD_AUDIO is granted.
 */
export function startKeepAlive(text?: string): void {
  Native.startKeepAlive(text ?? 'Bobby is listening');
}

export function stopKeepAlive(): void {
  Native.stopKeepAlive();
}

/** True when the app was opened by tapping Bobby's own notification (show settings, don't wake). */
export function openedFromNotification(): boolean {
  return Native.openedFromNotification();
}

export function clearOpenedFromNotification(): void {
  Native.clearOpenedFromNotification();
}

/** Whether Bobby's locked-phone unlock is set up and armed. Never returns the PIN or phrase. */
export function unlockStatus(): UnlockStatus {
  return Native.unlockStatus();
}

/**
 * Opens the native setup screen, where the owner confirms it's them and enters their PIN,
 * phrase and earbuds. The PIN stays native: it is never passed to or from JavaScript.
 */
export function openUnlockSetup(): void {
  Native.openUnlockSetup();
}

/** Forgets the stored PIN, phrase and their key. */
export function turnOffUnlock(): void {
  Native.turnOffUnlock();
}

/**
 * Called when the side button is held on a locked phone with the unlock armed. The app should
 * wake Bobby (it isn't brought to the front, since the phone is still locked).
 */
export function addAssistListener(fn: (e: { locked: boolean }) => void): { remove(): void } {
  return Native.addListener('onAssist', fn);
}

export default {
  unlockStatus,
  openUnlockSetup,
  turnOffUnlock,
  addAssistListener,
  configure,
  status,
  openSettings,
  moveToBack,
  startKeepAlive,
  stopKeepAlive,
  openedFromNotification,
  clearOpenedFromNotification,
};
