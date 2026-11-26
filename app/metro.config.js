// Metro setup for packages that live outside app/ (../hands, ../mind, ../mouth).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const appDir = __dirname;
const root = path.resolve(appDir, '..');
const config = getDefaultConfig(appDir);

// Let Metro see the sibling packages' files.
const pkgs = ['hands', 'mind', 'mouth'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
config.watchFolders = pkgs;

// One copy of every library: never load anything from a sibling package's own node_modules
// (the app installs every runtime dependency the packages need, per their MERGE.md).
const esc = (p) => p.replace(/[/\\]/g, '[/\\\\]').replace(/\./g, '\\.');
config.resolver.blockList = [
  ...[].concat(config.resolver.blockList || []),
  ...pkgs.map((p) => new RegExp(`^${esc(path.join(p, 'node_modules'))}[/\\\\].*`)),
];
config.resolver.nodeModulesPaths = [path.join(appDir, 'node_modules')];

// Fallback for packages that only have an `exports` map and no `main`:
// Expo's resolver chain falls back to `main` for them and fails, so read `exports` ourselves.
const CONDITIONS = ['react-native', 'require', 'import', 'default'];
function pickTarget(t) {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map(pickTarget).find(Boolean) || null;
  if (t && typeof t === 'object') {
    for (const c of CONDITIONS) if (c in t) { const r = pickTarget(t[c]); if (r) return r; }
  }
  return null;
}
function resolveFromExports(moduleName) {
  const parts = moduleName.split('/');
  const name = moduleName.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const sub = '.' + moduleName.slice(name.length);
  const dir = path.join(appDir, 'node_modules', name);
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const ex = pkg.exports;
  if (!ex) return null;
  const map = typeof ex === 'string' || Array.isArray(ex) || !Object.keys(ex).some((k) => k.startsWith('.')) ? { '.': ex } : ex;
  let target = sub in map ? pickTarget(map[sub]) : null;
  if (!target) {
    for (const [k, v] of Object.entries(map)) {
      const star = k.indexOf('*');
      if (star < 0) continue;
      const pre = k.slice(0, star), post = k.slice(star + 1);
      if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) {
        const t = pickTarget(v);
        if (t) target = t.replace('*', sub.slice(pre.length, sub.length - post.length));
        break;
      }
    }
  }
  if (!target) return null;
  const file = path.join(dir, target);
  return fs.existsSync(file) ? { type: 'sourceFile', filePath: file } : null;
}

// A bare import from a file outside app/ is resolved as if it came from app/.
const appOrigin = path.join(appDir, 'index.ts');
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = typeof upstream === 'function' ? upstream : context.resolveRequest;
  const bare = !moduleName.startsWith('.') && !path.isAbsolute(moduleName);
  let ctx = context;
  if (bare && !context.originModulePath.startsWith(appDir + path.sep)) {
    // A flat copy of every field, own or inherited: a spread would lose inherited ones, and
    // Object.create(context) loses all of them as soon as a resolver further down spreads it
    // ("getPackageForModule is not a function").
    ctx = {};
    for (const k in context) ctx[k] = context[k];
    ctx.originModulePath = appOrigin;
  }
  try {
    return resolve(ctx, moduleName, platform);
  } catch (e) {
    const viaExports = bare ? resolveFromExports(moduleName) : null;
    if (viaExports) return viaExports;
    throw e;
  }
};

module.exports = config;
