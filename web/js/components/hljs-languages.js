// Loaders for every highlight.js language, kept out of the entry chunk.
export const languageModules = import.meta.glob('../../../node_modules/highlight.js/es/languages/*.js');
export const languagePath = name => '../../../node_modules/highlight.js/es/languages/' + name + '.js';
