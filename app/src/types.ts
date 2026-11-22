export type Log = (line: string) => void;
export type PartConfig = {
  hubUrl: string;
  token: string;
  env: Record<string, string>;
  log: Log;
};
export type MindConfig = PartConfig & { hints: string[] };
export type Stoppable = { stop(): void };
export type MouthHandle = Stoppable & { wake(): void };
export type Part = 'mind' | 'mouth' | 'caller';
