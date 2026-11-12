// Centralized mutable state shared across modules.
// All cross-module reads/writes go through this object — never reassign cross-module bare vars.
// (Module-private vars stay in their owning file as plain `var`.)

export const state = {
  // ---- Credentials (api.js) ----
  KEY: '',
  SERVER: '',

  // ---- Navigation / device list (app.js) ----
  appState: { device: null, project: null, session: null, sessionPreview: '' },
  deviceOnlineMap: {},
  deviceDisplayNameMap: {},
  newSessionRuntimes: [],
  rootSessionId: null,
  rootSessionPreview: '',
  activeThreadId: null,
  activeThreadCanSend: true,
  sessionThreads: [],
  threadRequestVersion: 0,
  projectFilesOpen: false,
  gitStatusOpen: false,

  // ---- Batch-delete selection (app.js) ----
  selectMode: false,
  selectType: null,           // 'project' | 'session' — the two lists never mix-select
  selected: new Set(),        // selected ids (projectHash or sessionId)

  // ---- WebSocket connection + message state (ws.js) ----
  ws: null,
  wsSessionId: null,
  wsRootSessionId: null,
  wsMessageCount: 0,
  wsStatusText: '',
  wsAllMessages: [],          // all messages for the active session, sorted ascending
  wsMessageUuids: new Set(),  // UUID index for final persisted messages; streaming bypasses it
  wsProjectHash: null,        // for new session creation
  wsRequestId: null,          // unique ID per new-session creation flow
  wsRunning: false,           // active session still running
  stickBottom: true,          // auto-scroll intent: real user drag clears it; returning until the bottom button hides / tapping it restores
  _titleTier: 0,              // 4=customTitle 3=ai-title 2=firstUser 1=lastPrompt; never downgrade
  _titleRename: null,
  wsRenderedCount: 0,
  wsHasMore: false,           // more older messages on server
  wsOldestTimestamp: '',      // cursor for older-load
  wsTitleRows: [],            // title rows of the last history reply
  wsHistoryPhase: '',         // '' | 'slow' (past 6 s) | 'stale' (last load failed) | 'offline'
  wsLoadingOlder: false,
  _pendingCreatePath: null,   // projectPath for create_project matching
  pendingSentMessages: [],

  // ---- Image staging (image.js) ----
  stagedImages: [],

  // ---- File viewer (project/file-viewer.js) ----
};
