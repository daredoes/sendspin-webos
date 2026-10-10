#!/usr/bin/env node
// Writes the Homebrew Channel manifest and a one-app repository index for a release.
//   node scripts/hbc-repo.js <tag> <ipk-path>
// Outputs dist/webosbrew.manifest.json and dist/apps.json. Add
//   https://github.com/daredoes/sendspin-webos/releases/latest/download/apps.json
// as a custom repository in Homebrew Channel to install and update from releases.
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var REPO = 'https://github.com/daredoes/sendspin-webos';
var ICON = 'https://raw.githubusercontent.com/daredoes/sendspin-webos/main/icon.png';

function build(tag, ipkPath, appinfo) {
  var base = REPO + '/releases/download/' + tag + '/';
  var manifest = {
    id: appinfo.id,
    version: appinfo.version,
    type: appinfo.type,
    title: appinfo.title,
    appDescription: 'Music Assistant (Sendspin) player with a background audio service',
    iconUri: ICON,
    sourceUrl: REPO,
    rootRequired: true,
    ipkUrl: base + path.basename(ipkPath),
    ipkHash: { sha256: crypto.createHash('sha256').update(fs.readFileSync(ipkPath)).digest('hex') }
  };
  var apps = {
    paging: { page: 1, count: 1, maxPage: 1, itemsTotal: 1, prevUrl: null, nextUrl: null },
    packages: [{
      id: appinfo.id,
      title: appinfo.title,
      iconUri: ICON,
      manifestUrl: base + 'webosbrew.manifest.json',
      manifest: manifest,
      category: 'multimedia',
      description: manifest.appDescription,
      pool: 'main'
    }]
  };
  return { manifest: manifest, apps: apps };
}

module.exports = build;

if (require.main === module) {
  var tag = process.argv[2];
  var ipk = process.argv[3];
  if (!tag || !ipk) {
    console.error('usage: node scripts/hbc-repo.js <tag> <ipk-path>');
    process.exit(1);
  }
  var root = path.join(__dirname, '..');
  var out = build(tag, ipk, JSON.parse(fs.readFileSync(path.join(root, 'appinfo.json'), 'utf8')));
  fs.writeFileSync(path.join(root, 'dist', 'webosbrew.manifest.json'), JSON.stringify(out.manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'dist', 'apps.json'), JSON.stringify(out.apps, null, 2) + '\n');
  console.log('wrote dist/webosbrew.manifest.json and dist/apps.json for ' + tag);
}
