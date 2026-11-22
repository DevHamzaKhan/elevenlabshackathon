// Adds the parts that may or may not exist yet, so the app always builds:
// - the Hands config plugin (../hands/app.plugin.js) once it lands,
// - the app icon from ../stage/icon/ when Stage has made one.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

module.exports = ({ config }) => {
  const plugins = [...(config.plugins || [])];

  const handsPlugin = path.join(root, 'hands', 'app.plugin.js');
  if (fs.existsSync(handsPlugin)) plugins.unshift(handsPlugin);

  const iconDir = path.join(root, 'stage', 'icon');
  const pick = (...names) => names.map((n) => path.join(iconDir, n)).find((p) => fs.existsSync(p));
  const icon = pick('icon.png', 'app-icon.png', 'bobby.png');
  const fg = pick('android-icon-foreground.png', 'foreground.png', 'adaptive-foreground.png');
  const android = { ...config.android };
  if (icon) {
    config.icon = icon;
    android.adaptiveIcon = { backgroundColor: '#FFFFFF', foregroundImage: fg || icon };
  }

  return { ...config, android, plugins };
};
