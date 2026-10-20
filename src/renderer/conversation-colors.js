'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ForgeConversationColors = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const choices = Object.freeze({ white:'#fff', black:'#000', red:'#ff6b6b', yellow:'#ffd86b', green:'#79e6a2', blue:'#86b9ff' });
  const normalize = value => typeof value === 'string' && Object.hasOwn(choices, value) ? value : 'white';
  return Object.freeze({ choices, normalize, color:value => choices[normalize(value)] });
});
