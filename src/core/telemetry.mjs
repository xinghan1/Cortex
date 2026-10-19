// Streaming APIs generally publish exact usage only at the end. During a
// request the provider's text-based estimate is shown explicitly as an estimate.
export class RunTelemetry {
  constructor({ emit, clock = () => performance.now() }) {
    this.emit = emit; this.clock = clock; this.startedAt = clock();
    this.inputTokens = 0; this.outputTokens = 0;
    this.modelMs = 0; this.current = null; this.phase = 'idle';
    this.unknown = false;
  }
  begin() {
    this.current = { startedAt: this.clock(), estimatedOutputTokens: 0, usage: null };
    this.phase = 'waiting'; this.publish();
  }
  progress(sample = {}) {
    if (!this.current) return;
    if (Number.isFinite(sample.estimatedOutputTokens)) this.current.estimatedOutputTokens = Math.max(this.current.estimatedOutputTokens, sample.estimatedOutputTokens, 0);
    if (sample.usage) this.current.usage = sample.usage;
    if (sample.phase) this.phase = sample.phase === 'tool-call' ? 'generating' : sample.phase;
    this.publish();
  }
  finish(usage, { reported = true, partial = false } = {}) {
    if (!this.current) return;
    this.modelMs += Math.max(0, this.clock() - this.current.startedAt);
    if (reported && usage) {
      this.inputTokens += usage.inputTokens || 0;
      this.outputTokens += usage.outputTokens || 0;
    }
    this.unknown ||= !reported || partial;
    this.current = null;
    this.phase = 'idle';
    this.publish();
  }
  setPhase(phase) { this.phase = phase; this.publish(); }
  publish() {
    const current = this.current;
    const estimated = Boolean(current) || this.unknown;
    const output = this.outputTokens + (current?.estimatedOutputTokens || 0);
    const modelMs = this.modelMs + (current ? Math.max(0, this.clock() - current.startedAt) : 0);
    const generating = ['thinking', 'generating', 'completed'].includes(this.phase);
    const tokensPerSecond = generating && modelMs > 0 && output > 0
      ? Math.round(output / Math.max(0.25, modelMs / 1000) * 10) / 10 : null;
    this.emit({ type: 'telemetry', phase: this.phase,
      estimatedOutputTokens: output,
      outputTokens: this.outputTokens + (current?.usage?.outputTokens || 0),
      inputTokens: this.inputTokens + (current?.usage?.inputTokens || 0),
      tokensPerSecond, estimated, elapsedMs: Math.round(this.clock() - this.startedAt),
      modelMs: Math.round(modelMs), incomplete: this.unknown });
  }
}
