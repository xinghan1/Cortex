// These are protocol values, not an application's fixed low/medium/high scale.
export const officialReasoningValue = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
const label = (value, fallback) => officialReasoningValue(value) ? value : fallback;
export function officialReasoningMetadata(options = [], { defaultValue, currentValue } = {}) {
  if (!Array.isArray(options) || options.length > 128) throw new Error('Invalid official reasoning options');
  const seen = new Set(), reasoningOptions = options.map(option => {
    if (!officialReasoningValue(option?.value) || seen.has(option.value)) throw new Error('Invalid official reasoning option');
    seen.add(option.value); return { value: option.value, label: label(option.label ?? option.name, option.value) };
  });
  return { reasoningEfforts: reasoningOptions.map(option => option.value), reasoningOptions,
    ...(seen.has(defaultValue) ? { defaultReasoningEffort: defaultValue } : {}),
    ...(seen.has(currentValue) ? { currentReasoningEffort: currentValue } : {}) };
}
export function acpModelOption(session) {
  const options = session?.configOptions;
  return Array.isArray(options) ? options.find(option => option?.type === 'select' && option.category === 'model')
    || options.find(option => option?.type === 'select' && option.id === 'model') || null : null;
}
export function acpReasoningOption(session) {
  const options = session?.configOptions;
  // Category supplies the meaning; the agent's actual id is sent unchanged.
  return Array.isArray(options) ? options.find(option => option?.type === 'select' && option.category === 'thought_level')
    || options.find(option => option?.type === 'select' && option.id === 'thought_level') || null : null;
}
export function acpCurrentModel(session) {
  const current = acpModelOption(session)?.currentValue ?? session?.currentModelId ?? session?.models?.currentModelId;
  return officialReasoningValue(current) ? current : Array.isArray(session?.models) && session.models.length === 1 ? session.models[0].id : undefined;
}
export function acpReasoningMetadata(session) {
  const option = acpReasoningOption(session);
  if (!option) return officialReasoningMetadata();
  if (!officialReasoningValue(option.id) || !Array.isArray(option.options) || option.options.length > 128) throw new Error('Invalid official reasoning config');
  const options = option.options.flatMap(row => Array.isArray(row?.options) ? row.options : [row]);
  return officialReasoningMetadata(options, { defaultValue: option.defaultValue, currentValue: option.currentValue });
}
export function acpModelsWithReasoning(models, session) {
  const current = acpCurrentModel({ ...session, currentModelId: session?.currentModelId ?? session?.models?.currentModelId, models }), metadata = acpReasoningMetadata(session);
  return models.map(model => {
    const { reasoningEfforts, reasoningOptions, defaultReasoningEffort, currentReasoningEffort, reasoningModelId, ...base } = model;
    return { ...base, ...(model.id === current ? metadata : officialReasoningMetadata()),
      ...(model.id === current && metadata.reasoningOptions.length ? { reasoningModelId: current } : {}) };
  });
}
export function updateAcpConfig(session, configOptions) {
  if (!Array.isArray(configOptions) || configOptions.length > 256 || JSON.stringify(configOptions).length > 1024 * 1024) throw new Error('Invalid official config options');
  session.configOptions = structuredClone(configOptions);
  const current = acpModelOption(session)?.currentValue;
  if (officialReasoningValue(current)) session.currentModelId = current;
  session.models = acpModelsWithReasoning(session.models, session);
}
// A config response is a complete snapshot. Notifications are accepted only for
// this exact session and only while the corresponding request is in flight.
export async function requestAcpConfig({ client, session, method, params, options, collectors, modelId }) {
  let notified;
  const collect = event => { if (event?.sessionId === session.id && event.update?.sessionUpdate === 'config_option_update') notified = event.update.configOptions; };
  collectors.add(collect);
  try {
    const result = await client.request(method, params, options);
    const config = result?.configOptions ?? notified;
    if (config !== undefined) updateAcpConfig(session, config);
    else if (modelId && modelId !== acpCurrentModel(session)) {
      // A legacy selection response cannot prove the new model's capabilities.
      session.currentModelId = modelId;
      session.configOptions = session.configOptions.filter(option => option !== acpReasoningOption(session)).map(option => option === acpModelOption(session) ? { ...option, currentValue: modelId } : option);
      session.models = acpModelsWithReasoning(session.models, session);
    }
    if (modelId && acpCurrentModel(session) !== modelId) throw new Error('Official model selection was not applied');
    return result;
  } finally { collectors.delete(collect); }
}
export function needsAcpReasoningReset(session, effort) {
  return effort === 'default' && Boolean(acpReasoningOption(session)) && !acpReasoningMetadata(session).defaultReasoningEffort
    && Boolean(session.reasoningOverridden || session.resumed);
}
export async function setAcpReasoning({ client, session, effort, options, collectors, unavailable }) {
  const metadata = acpReasoningMetadata(session), option = acpReasoningOption(session);
  const value = effort === 'default' ? metadata.defaultReasoningEffort : effort;
  if (effort !== 'default' && !metadata.reasoningEfforts.includes(effort)) throw unavailable();
  if (value === undefined) return;
  if (!option || !metadata.reasoningEfforts.includes(value)) throw unavailable();
  await requestAcpConfig({ client, session, method: 'session/set_config_option', params: { sessionId: session.id, configId: option.id, value }, options, collectors });
  const actual = acpReasoningMetadata(session).currentReasoningEffort;
  // Compliant agents return the authoritative current value; never hide a clamp.
  if (actual !== value) throw unavailable();
  session.reasoningOverridden = effort !== 'default';
}
