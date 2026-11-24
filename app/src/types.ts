export type Log = (line: string) => void;
export type PartConfig = {
  hubUrl: string;
  token: string;
  env: Record<string, string>;
  log: Log;
};
/** `storage` (AsyncStorage-shaped) keeps the Mind's memory and recipes across restarts. */
export type KeyValueStore = { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> };
export type MindConfig = PartConfig & { hints: string[]; storage?: KeyValueStore };
export type Stoppable = { stop(): void };
export type MouthHandle = Stoppable & { wake(): void };
export type Part = 'mind' | 'mouth' | 'caller';
