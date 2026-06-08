export interface ModelMappingConfig {
  anthropic_to_bluesminds: Record<string, string>;
  default?: string;
  family_rules?: FamilyRule[];
}

/** A glob-style pattern rule for routing unmapped Claude model names. */
export interface FamilyRule {
  /** Human-readable name, e.g. "Haiku" */
  name: string;
  /** Glob pattern matched against the incoming Claude model name, e.g. "claude*haiku*" */
  pattern: string;
  /** Primary provider model to route to */
  primary: string;
  /** Optional backup model if primary fails (not enforced by proxy yet, informational) */
  backup?: string;
}
