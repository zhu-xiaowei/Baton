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

  // ---- WebSocket connection + message state (ws.js) ----
  ws: null,
  wsSessionId: null,
  wsMessageCount: 0,
  wsStatusText: '',
  wsAllMessages: [],          // all messages for the active session, sorted ascending
  wsLastTimestamp: '',        // for reconnect recovery
  wsProjectHash: null,        // for new session creation
  wsRequestId: null,          // unique ID per new-session creation flow
  wsRunning: false,           // active session still running
  wsLoadCompleteTs: '',       // watermark: only WS messages newer than this can flip wsRunning
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
  _pendingFileReq: null,      // { requestId, timer }
  _fileReqSeq: 0,
};
