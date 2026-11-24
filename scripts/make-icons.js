// Turns the logo SVGs in assets/ into every PNG the app needs, plus the app icons for macOS, Windows and Linux.
// Run with: npm run icons   (edit assets/app-icon.svg or assets/logo.svg first if you want to change the logo)
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = (p) => path.join(root, p);

async function rasterize(win, svgFile) {
  const svg = fs.readFileSync(out(svgFile), 'utf8').replace('<svg ', '<svg width="1024" height="1024" ');
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  return win.webContents.capturePage();
}

function save(img, size, file) {
  const png = img.resize({ width: size, height: size, quality: 'best' }).toPNG();
  fs.mkdirSync(path.dirname(out(file)), { recursive: true });
  fs.writeFileSync(out(file), png);
}

app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1024, height: 1024, useContentSize: true, frame: false,
    transparent: true, backgroundColor: '#00000000', paintWhenInitiallyHidden: true,
  });
  const icon = await rasterize(win, 'assets/app-icon.svg');
  for (const s of [16, 32, 64, 128, 256, 512, 1024]) save(icon, s, `assets/app-icon-${s}.png`);
  save(icon, 512, 'src/assets/icon.png'); // used for notifications, the Dock and the Windows/Linux tray
  save(icon, 1024, 'build/icon.png'); // Windows .ico and Linux icons are made from this by electron-builder
  const logo = await rasterize(win, 'assets/logo.svg');
  for (const s of [64, 256, 512]) save(logo, s, `assets/logo-${s}.png`);

  // macOS .icns for the packaged app (npm run dist)
  if (process.platform === 'darwin') {
    const set = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-icon-')) + '/icon.iconset';
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      save(icon, s, path.relative(root, `${set}/icon_${s}x${s}.png`));
      save(icon, s * 2, path.relative(root, `${set}/icon_${s}x${s}@2x.png`));
    }
    fs.mkdirSync(out('build'), { recursive: true });
    execFileSync('iconutil', ['-c', 'icns', set, '-o', out('build/icon.icns')]);
  }
  console.log('Icons written to assets/, src/assets/icon.png, build/icon.png' + (process.platform === 'darwin' ? ' and build/icon.icns' : ''));
  app.quit();
});
