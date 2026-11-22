// Copies the cursor Stage chose (named in ../stage/cursor/CHOSEN) into the app as
// res/drawable/cursor.xml. App resources override library ones, so Hands draws it.
// CHOSEN may hold a design name ("ring"), or a file name ("cursor_ring.xml").
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

module.exports = function withBobbyArt(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const dir = path.resolve(cfg.modRequest.projectRoot, '..', 'stage', 'cursor');
      const chosenFile = path.join(dir, 'CHOSEN');
      if (!fs.existsSync(chosenFile)) return cfg;
      const name = fs.readFileSync(chosenFile, 'utf8').trim().split(/\s+/)[0];
      const candidates = [name, `cursor_${name}.xml`, `${name}.xml`].map((n) => path.join(dir, n));
      const src = candidates.find((p) => fs.existsSync(p) && p.endsWith('.xml'));
      if (!src) {
        console.warn(`[with-bobby-art] CHOSEN names "${name}" but no matching xml in stage/cursor`);
        return cfg;
      }
      const dest = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/drawable/cursor.xml');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      console.log(`[with-bobby-art] cursor: ${path.basename(src)}`);
      return cfg;
    },
  ]);
};
