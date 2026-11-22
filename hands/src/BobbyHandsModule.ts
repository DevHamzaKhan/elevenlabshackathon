import { NativeModule, requireNativeModule } from 'expo';

import { HandsStatus, SettingsPage } from './BobbyHands.types';

declare class BobbyHandsNative extends NativeModule<{}> {
  configure(options: { token: string }): void;
  status(): HandsStatus;
  openSettings(which: SettingsPage): void;
  moveToBack(): boolean;
  startKeepAlive(text?: string): void;
  stopKeepAlive(): void;
  openedFromNotification(): boolean;
  clearOpenedFromNotification(): void;
}

export default requireNativeModule<BobbyHandsNative>('BobbyHands');
