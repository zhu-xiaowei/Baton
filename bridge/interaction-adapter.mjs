const REQUIRED_METHODS = [
  'sendExisting',
  'interrupt',
  'replyControl',
  'owns',
  'isBusy',
];

const OPTIONAL_METHODS = ['shutdown'];

export function defineInteractionAdapter(definition) {
  if (!definition?.runtime || typeof definition.runtime !== 'string') {
    throw new TypeError('interaction adapter requires a runtime id');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof definition[method] !== 'function') {
      throw new TypeError(`${definition.runtime} interaction adapter requires ${method}()`);
    }
  }
  for (const method of OPTIONAL_METHODS) {
    if (definition[method] !== undefined && typeof definition[method] !== 'function') {
      throw new TypeError(`${definition.runtime} interaction adapter ${method} must be a function`);
    }
  }
  return definition;
}
