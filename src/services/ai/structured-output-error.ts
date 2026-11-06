/** A completed OpenCode response with no structured decision to validate. */
export class MissingStructuredOutputError extends Error {
  constructor() {
    super(
      "opencode-mem: opencode returned no structured output (info.structured_output/info.structured were empty)"
    );
    this.name = "MissingStructuredOutputError";
  }
}
