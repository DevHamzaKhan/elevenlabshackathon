// The app's log: the last 200 lines, shown on the settings screen.
const MAX = 200;
const lines: string[] = [];
const listeners = new Set<() => void>();

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function log(line: string): void {
  const text = `${stamp()} ${line}`;
  console.log(`[bobby] ${text}`);
  lines.push(text);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
  listeners.forEach((l) => l());
}

export const logFor = (part: string) => (line: string) => log(`${part}: ${line}`);
export const getLines = (): string[] => lines.slice();
export function onLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
