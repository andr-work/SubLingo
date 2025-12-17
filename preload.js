const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    // Get desktop sources for system audio capture
    getDesktopSources: async () => {
        return await ipcRenderer.invoke('get-desktop-sources');
    }
});
