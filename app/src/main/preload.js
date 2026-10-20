// The only bridge between the UI and the main process.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("orthoviz", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  checkFolder: (folder) => ipcRenderer.invoke("check-folder", folder),
  pathForDroppedFile: (file) => webUtils.getPathForFile(file),
  startProcessing: (folder) => ipcRenderer.invoke("start-processing", folder),
  cancelProcessing: () => ipcRenderer.invoke("cancel-processing"),
  buildModel: (outputDir) => ipcRenderer.invoke("build-model", outputDir),
  startupResult: () => ipcRenderer.invoke("startup-result"),
  onProgress: (cb) => subscribe("processing-progress", cb),
  onFinished: (cb) => subscribe("processing-finished", cb),
});
