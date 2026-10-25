import fs from 'node:fs/promises';
import vm from 'node:vm';
const registry = await fs.readFile(new URL('./zcode-provider-registry-v0170.ts', import.meta.url), 'utf8');
const selection = await fs.readFile(new URL('./zcode-provider-registry-selection-v0170.ts', import.meta.url), 'utf8');
function nativeBody(source, name, signatureEnd) {
  const start = source.indexOf(`function ${name}(`), open = source.indexOf(signatureEnd, start) + signatureEnd.length - 1;
  const end = source.indexOf('\n}', open) + 2;
  if (start < 0 || open < start || end < open) throw Error('Pinned native model contract fixture changed');
  return source.slice(open, end);
}
// Execute the actual upstream JS function bodies; only their TS signatures are
// supplied separately. No duplicate hand-written reasoning validator is used.
const validate = vm.runInNewContext(`(function(model, selection)${nativeBody(registry, 'validateModelSelectionOptions', '): ModelSelectionValidation {')})`);
export const nativeModelOption = vm.runInNewContext(`(function(provider, model)${nativeBody(selection, 'toModelOption', '): ZCodeModelOption {')})`);
const resolveModel = vm.runInNewContext(`(function(registry, selection)${nativeBody(selection, 'resolveRegistryModelSelection', '): ResolvedRegistrySelection | undefined {')})`);
const resolveOwned = vm.runInNewContext(`(function(registry, selection, options)${nativeBody(selection, 'resolveRegistryOwnedModelSelection', '): ResolvedRegistrySelection | undefined {')})`, {
  resolveRegistryModelSelection: resolveModel,
  createRegistrySelectionProtocolError: error => Object.assign(new Error(error.code), { code: error.code }),
});
export function resolveNativeModel(provider, model, requested) {
  return resolveOwned({
    validateSelection: value => validate(model, value),
    getProvider: value => value === provider.providerId ? provider : undefined,
    getModel: (providerId, modelId) => providerId === provider.providerId && modelId === model.modelId ? model : undefined,
  }, requested);
}
