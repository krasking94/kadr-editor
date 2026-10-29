// Безопасный мост: окно программы получает только эти функции.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const on = (channel: string) => (cb: (payload: any) => void) => {
  const h = (_e: unknown, p: any) => cb(p);
  ipcRenderer.on(channel, h);
  return () => { ipcRenderer.removeListener(channel, h); };
};
const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api = {
  info: call('app:info'),
  setTitle: call('app:set-title'),
  setTitlebar: call('app:titlebar'),
  toggleFullscreen: call('app:toggle-fullscreen'),
  devtools: call('app:devtools'),
  sampleMedia: call('app:sample-media'),
  confirmClose: () => ipcRenderer.send('app:close-confirmed'),
  onCloseRequest: on('app:close-request'),
  onOpenPath: on('project:open-path'),

  openPath: call('shell:open-path'),
  showItem: call('shell:show-item'),
  openExternal: call('shell:open-external'),

  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  setSecret: call('settings:set-secret'),

  openMediaDialog: call('dialog:open-media'),
  openProjectDialog: call('dialog:open-project'),
  saveProjectDialog: call('dialog:save-project'),
  exportPathDialog: call('dialog:export-path'),
  relinkDialog: call('dialog:relink'),
  folderDialog: call('dialog:folder'),

  readProject: call('project:read'),
  writeProject: call('project:write'),
  autosave: call('project:autosave'),
  autosaves: call('project:autosaves'),
  readAutosave: call('project:read-autosave'),
  dropAutosave: call('project:drop-autosave'),
  removeRecent: call('project:remove-recent'),

  probe: call('media:probe'),
  thumbs: call('media:thumbs'),
  waveform: call('media:waveform'),
  silence: call('media:silence'),
  scenes: call('media:scenes'),
  exists: call('media:exists'),
  frameAt: call('media:frame-at'),
  saveRecording: call('media:save-recording'),
  saveImage: call('media:save-image'),
  pathForFile: (f: File) => webUtils.getPathForFile(f),

  exportStart: call('export:start'),
  exportCancel: call('export:cancel'),
  taskbarProgress: call('export:taskbar'),
  onExportProgress: on('export:progress'),
  renderFrame: call('render:frame'),

  transcribe: call('ai:transcribe'),
  aiChat: call('ai:chat'),
  aiStop: call('ai:stop'),
  aiReset: call('ai:reset'),
  aiModels: call('ai:models'),
  onAiEvent: on('ai:event'),

  mcpStatus: call('mcp:status'),
  mcpRestart: call('mcp:restart'),
  onMcpClient: on('mcp:client'),
  onMcpClients: on('mcp:clients'),

  onToolCall: on('tool:call'),
  toolResult: (id: number, result: unknown) => ipcRenderer.send('tool:result', id, result),
};

contextBridge.exposeInMainWorld('kadr', api);
export type KadrApi = typeof api;
