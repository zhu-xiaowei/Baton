const REQUIRED_METHODS = [
  'discover',
  'detectCapability',
  'findSessionFile',
  'shouldSkipInitial',
  'baselineToEnd',
  'syncInitialMessages',
  'syncAllMessages',
];

const DEFAULT_FEATURES = {
  read: true,
  create: false,
  send: false,
  interrupt: false,
  deleteHistory: false,
  statusPolling: false,
};

const OPTIONAL_METHODS = {
  deleteSessionHistory: () => false,
  deleteProjectHistory: () => false,
  ownsLiveSession: () => false,
  createStatusContext: () => ({}),
  inspectActiveSession: () => null,
  updateSessionStatus: async () => {},
};

const FEATURE_METHODS = {
  deleteHistory: ['deleteSessionHistory', 'deleteProjectHistory'],
  statusPolling: ['createStatusContext', 'inspectActiveSession', 'updateSessionStatus'],
};

export function defineRuntimeAdapter(definition) {
  if (!definition?.runtime || typeof definition.runtime !== 'string') {
    throw new TypeError('runtime adapter requires a runtime id');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof definition[method] !== 'function') {
      throw new TypeError(`${definition.runtime} runtime adapter requires ${method}()`);
    }
  }
  const features = { ...DEFAULT_FEATURES, ...(definition.features || {}) };
  for (const [feature, methods] of Object.entries(FEATURE_METHODS)) {
    if (!features[feature]) continue;
    for (const method of methods) {
      if (typeof definition[method] !== 'function') {
        throw new TypeError(`${definition.runtime} runtime adapter with ${feature} requires ${method}()`);
      }
    }
  }
  return Object.freeze({
    ...OPTIONAL_METHODS,
    ...definition,
    features: Object.freeze(features),
  });
}
