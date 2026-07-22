const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { start } = require('../server');

// Port 0 = any free port, so the desktop app never conflicts with a
// separately running `npm start` web server.
async function createWindow() {
  const port = await start(0);
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'dockeru',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#0f141a',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${port}`);
  // External links (if any) go to the system browser, not the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
