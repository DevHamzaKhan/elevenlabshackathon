import { registerRootComponent } from 'expo';

// bobby-mind (via @anthropic-ai/sdk, which has circular imports) crashes dev builds when React
// Refresh reads its exports while they are still loading. Load it once with Refresh hidden
// (mind/MERGE.md, "Dev builds"). Release builds are unaffected. Must run before App is loaded,
// so App is required, not imported (imports are hoisted).
const g = globalThis as { __ReactRefresh?: unknown };
const refresh = g.__ReactRefresh;
g.__ReactRefresh = undefined;
try {
  require('bobby-mind');
} finally {
  g.__ReactRefresh = refresh;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const App = require('./App').default;

registerRootComponent(App);
