// Centralized mutable state shared across modules.
// All cross-module reads/writes go through this object — never reassign cross-module bare vars.
// (Module-private vars stay in their owning file as plain `var`.)

export const state = {
  // ---- Credentials (api.js) ----
  KEY: '',
  SERVER: '',
  WS_URL: '',

  // ---- Navigation / device list (app.js) ----
  appState: { device: null, project: null, session: null, sessionPreview: '' },
  deviceOnlineMap: {},
  deviceDisplayNameMap: {},
  deviceRuntimeCapabilities: {},
  newSessionRuntimes: [],
  rootSessionId: null,
  rootSessionPreview: '',
  activeThreadId: null,
  activeThreadCanSend: true,
  sessionThreads: [],
  threadRequestVersion: 0,

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
  wsLastTimestamp: '',        // for reconnect recovery
  wsProjectHash: null,        // for new session creation
  wsRequestId: null,          // unique ID per new-session creation flow
  wsRunning: false,           // active session still running (derived via deriveRunning)
  stickBottom: true,          // auto-scroll intent: true = follow new content; user up-scroll clears it, reaching bottom / tapping the button restores it
  _titleTier: 0,              // 4=customTitle 3=ai-title 2=lastPrompt 1=firstUser; never downgrade
  wsRenderedCount: 0,
  wsHasMore: false,           // more older messages on server
  wsOldestTimestamp: '',      // cursor for older-load
  wsLoadingOlder: false,
  _wsBuffer: null,            // null = normal mode, [] = buffering during initial load
  _syncedOnce: null,          // sessionId already re-fetched once after sync_complete (anti-loop)
  _pendingCreatePath: null,   // projectPath for create_project matching
  pendingSentMessages: [],

  // ---- Image staging (image.js) ----
  stagedImages: [],

  // ---- File viewer (fileviewer.js) ----
  fileCache: new Map(),       // key → { text, path, truncated }
  videoUrlCache: new Map(),   // key → { url, exp } — presigned GET URL + expiry (ms epoch)
  _pendingFileReq: null,      // { requestId, timer }
  _fileReqSeq: 0,
};
