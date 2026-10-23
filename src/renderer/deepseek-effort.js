'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ForgeDeepSeekEffort = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const photos = Object.freeze({ none: 'off', minimal: 'low', low: 'low', enabled: 'high', medium: 'high', high: 'high', xhigh: 'high', max: 'max' });
  function resolve({ provider, modelId, effort, defaultEffort, known = false, available = false, options = [] } = {}) {
    const deepseek = provider === 'deepseek' || typeof modelId === 'string' && /(?:^|[/:])deepseek(?=$|[-_:.\/])/iu.test(modelId);
    if (!deepseek || !available) return null;
    // Defaults are only decorative when the catalogue declares their meaning;
    // slider position and display names never infer a model or reasoning level.
    const selected = effort === 'default' ? known && options.includes(defaultEffort) ? defaultEffort : null : effort;
    return Object.hasOwn(photos, selected) ? photos[selected] : null;
  }
  function update(card, selection) {
    if (!card) return;
    const photo = resolve(selection);
    if (photo) card.dataset.deepseekEffort = photo;
    else delete card.dataset.deepseekEffort;
  }
  return Object.freeze({ resolve, update });
});
