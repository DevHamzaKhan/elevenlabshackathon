import { registerRootComponent } from 'expo';

// Load bobby-mind (and @anthropic-ai/sdk under it) while React Refresh is hidden.
// In dev builds Metro's require() hands every freshly loaded module's exports to React Refresh,
// reading each export getter. The SDK has circular imports (beta/messages <-> BetaToolRunner),
// so one getter is read before its module has finished loading and throws
// "Cannot read property 'BetaToolRunner' of undefined". Hiding Refresh for this one require
// skips that registration; nothing in the SDK is a React component, so nothing is lost.
// See mind/MERGE.md "Running inside Expo".
const g = globalThis as any;
const refreshKey = '__ReactRefresh';
const refresh = g[refreshKey];
g[refreshKey] = undefined;
try {
  require('bobby-mind');
} finally {
  g[refreshKey] = refresh;
}

// A plain require, not an import: imports are hoisted above the code that hides Refresh.
const App = require('./App').default;

registerRootComponent(App);
