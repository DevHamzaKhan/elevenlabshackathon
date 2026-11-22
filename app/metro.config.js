// Metro setup for packages that live outside app/ (../hands, ../mind, ../mouth).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const appDir = __dirname;
const root = path.resolve(appDir, '..');
const config = getDefaultConfig(appDir);

// Let Metro see the sibling packages' files.
config.watchFolders = ['hands', 'mind', 'mouth']
  .map((d) => path.join(root, d))
  .filter((d) => fs.existsSync(d));

// One copy of every shared library: a bare import from a file outside app/ is resolved
// as if it came from app/ first (react, react-native, expo...), and only falls back to
// the package's own node_modules when the app doesn't have it (e.g. Mind's own SDK).
const appOrigin = path.join(appDir, 'index.ts');
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream || context.resolveRequest;
  const bare = !moduleName.startsWith('.') && !path.isAbsolute(moduleName);
  if (bare && !context.originModulePath.startsWith(appDir + path.sep)) {
    try {
      return resolve({ ...context, originModulePath: appOrigin }, moduleName, platform);
    } catch {
      // fall through to the normal lookup
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
