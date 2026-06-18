/**
 * A scripted, offline language model for tests. It records every prompt it receives and returns
 * canned responses, so tests can assert how often the real model *would* have been called (e.g. to
 * verify a semantic cache hit avoided a model call).
 */
export class MockModel {
  /** Every prompt passed to {@link generate}, in order. */
  readonly calls: string[] = [];
  private responses: string[];
  private fallback: (prompt: string) => string;

  constructor(opts: { responses?: string[]; fallback?: (prompt: string) => string } = {}) {
    this.responses = opts.responses ?? [];
    this.fallback = opts.fallback ?? ((p) => `echo: ${p}`);
  }

  /** Number of times the model was actually invoked. */
  get callCount(): number {
    return this.calls.length;
  }

  /** Generate a completion for `prompt`, consuming the scripted responses in order. */
  generate = async (prompt: string): Promise<string> => {
    this.calls.push(prompt);
    if (this.responses.length > 0) {
      return this.responses.shift() as string;
    }
    return this.fallback(prompt);
  };
}
