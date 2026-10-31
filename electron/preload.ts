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
  minimize: call('app:minimize'),
  restore: call('app:restore'),
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
  openLutDialog: call('dialog:open-lut'),
  openSubtitlesDialog: call('dialog:open-subtitles'),
  saveTextDialog: call('dialog:save-text'),
  readText: call('file:read-text'),
  writeText: call('file:write-text'),

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
  processClip: call('media:process'),
  processCancel: call('media:process-cancel'),
  nobgPrepare: call('nobg:prepare'),
  nobgFrames: call('nobg:frames'),
  nobgWrite: call('nobg:write'),
  nobgFinish: call('nobg:finish'),
  nobgCancel: call('nobg:cancel'),
  makeProxy: call('media:proxy'),
  beats: call('media:beats'),
  onProcessProgress: on('media:process-progress'),
  audioSnippet: call('audio:snippet'),
  loudness: call('audio:loudness'),
  screenSources: call('screen:sources'),
  chooseScreen: call('screen:choose'),

  updateCheck: call('update:check'),
  updateDownload: call('update:download'),
  updateInstall: call('update:install'),
  updateState: call('update:state'),
  onUpdateState: on('update:state'),

  exportStart: call('export:start'),
  exportCancel: call('export:cancel'),
  taskbarProgress: call('export:taskbar'),
  onExportProgress: on('export:progress'),
  renderFrame: call('render:frame'),

  transcribe: call('ai:transcribe'),
  transcribeMedia: call('ai:transcribe-media'),
  transcribeMediaCancel: call('ai:transcribe-media-cancel'),
  onTranscribeProgress: on('ai:transcribe-progress'),
  aiChat: call('ai:chat'),
  aiStop: call('ai:stop'),
  aiReset: call('ai:reset'),
  aiModels: call('ai:models'),
  aiComplete: call('ai:complete'),
  onAiEvent: on('ai:event'),

  genImage: call('gen:image'),
  genSpeech: call('gen:speech'),
  genSfx: call('gen:sfx'),
  genMusic: call('gen:music'),
  genVoices: call('gen:voices'),
  genVideo: call('gen:video'),
  genVideoCancel: call('gen:video-cancel'),
  onGenVideoStatus: on('gen:video-status'),
  openImageDialog: call('dialog:open-image'),
  saveImageAs: call('media:save-image-as'),
  saveBytes: call('media:save-bytes'),
  downloadMedia: call('media:download'),
  clipboardMedia: call('clipboard:media'),

  mcpStatus: call('mcp:status'),
  mcpRestart: call('mcp:restart'),
  mcpDesktopStatus: call('mcp:desktop-status'),
  mcpDesktopConnect: call('mcp:desktop-connect'),
  mcpDesktopEntry: call('mcp:desktop-entry'),
  onMcpClient: on('mcp:client'),
  onMcpClients: on('mcp:clients'),

  onToolCall: on('tool:call'),
  toolResult: (id: number, result: unknown) => ipcRenderer.send('tool:result', id, result),
};

contextBridge.exposeInMainWorld('kadr', api);
export type KadrApi = typeof api;
