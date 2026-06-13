const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function afterSign(context) {
  const { appOutDir, packager } = context;
  if (packager.platform.name !== 'mac') return;

  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const loginItemsDir = path.join(appPath, 'Contents', 'Library', 'LoginItems');

  if (!fs.existsSync(loginItemsDir)) return;

  const helpers = fs.readdirSync(loginItemsDir).filter(f => f.endsWith('.app'));

  for (const helper of helpers) {
    const helperApp = path.join(loginItemsDir, helper);
    const helperBin = path.join(helperApp, 'Contents', 'MacOS', path.basename(helper, '.app'));

    try {
      if (fs.existsSync(helperBin)) {
        console.log(`[afterSign] Removing existing signature from ${path.basename(helperBin)}`);
        execSync(`codesign --remove-signature "${helperBin}"`, { stdio: 'pipe' });
      }
      console.log(`[afterSign] Removing existing signature from ${helper}`);
      execSync(`codesign --remove-signature "${helperApp}"`, { stdio: 'pipe' });
    } catch (e) {
      // ignore — binary may not be signed yet
    }

    // Strip any resource forks
    try {
      execSync(`xattr -cr "${helperApp}"`, { stdio: 'pipe' });
    } catch (e) {}
  }
};
