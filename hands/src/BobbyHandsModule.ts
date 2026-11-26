import { NativeModule, requireNativeModule } from 'expo';

import { BobbyHandsEvents, HandsStatus, SettingsPage, UnlockStatus } from './BobbyHands.types';

declare class BobbyHandsNative extends NativeModule<BobbyHandsEvents> {
  configure(options: { token: string }): void;
  status(): HandsStatus;
  openSettings(which: SettingsPage): void;
  moveToBack(): boolean;
  startKeepAlive(text?: string): void;
  stopKeepAlive(): void;
  openedFromNotification(): boolean;
  clearOpenedFromNotification(): void;
  unlockStatus(): UnlockStatus;
  openUnlockSetup(): void;
  turnOffUnlock(): void;
}

export default requireNativeModule<BobbyHandsNative>('BobbyHands');
