// The test app installs bobby-mouth from ".." (a symlink). Let Metro see the package source,
// but resolve every dependency from this app's node_modules only, so there is one React.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);
const pkg = path.resolve(__dirname, "..");
config.watchFolders = [pkg];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
config.resolver.blockList = [new RegExp(`^${path.join(pkg, "node_modules").replace(/[/\\]/g, "[/\\\\]")}[/\\\\].*`)];
module.exports = config;
