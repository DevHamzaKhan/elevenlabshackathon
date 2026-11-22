// Metro config for the bobby-mind example app.
// bobby-mind is installed as `file:..`, which npm makes a symlink to the mind/ folder.
// Metro follows the symlink, so it must also watch mind/ and look up modules in
// mind/node_modules (where @anthropic-ai/sdk lives).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const mindRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [mindRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(mindRoot, 'node_modules'),
];

module.exports = config;
