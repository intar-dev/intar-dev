export type FeatureTogglePrimitive = string | number | boolean;

export type FeatureToggleContext = Readonly<
  Record<string, FeatureTogglePrimitive>
>;

export interface FeatureToggleService {
  getBoolean(
    key: string,
    defaultValue: boolean,
    context?: FeatureToggleContext,
  ): Promise<boolean>;
}

export interface FlagshipBooleanBinding {
  getBooleanValue(
    key: string,
    defaultValue: boolean,
    context?: Record<string, FeatureTogglePrimitive>,
  ): Promise<boolean>;
}

export class FlagshipFeatureToggleService implements FeatureToggleService {
  constructor(private readonly binding: FlagshipBooleanBinding | null) {}

  async getBoolean(
    key: string,
    defaultValue: boolean,
    context: FeatureToggleContext = {},
  ): Promise<boolean> {
    if (!this.binding) return defaultValue;

    try {
      return await this.binding.getBooleanValue(key, defaultValue, {
        ...context,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "feature_toggle_evaluation_failed",
          key,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return defaultValue;
    }
  }
}

export class StaticFeatureToggleService implements FeatureToggleService {
  constructor(
    private readonly values: Readonly<Record<string, boolean>> = {},
  ) {}

  async getBoolean(
    key: string,
    defaultValue: boolean,
    _context?: FeatureToggleContext,
  ): Promise<boolean> {
    return this.values[key] ?? defaultValue;
  }
}

export function flagshipBindingFromEnvironment(
  environment: unknown,
): FlagshipBooleanBinding | null {
  if (!isRecord(environment)) return null;
  const candidate = environment.FLAGS;
  if (!isRecord(candidate)) return null;
  return typeof candidate.getBooleanValue === "function"
    ? (candidate as unknown as FlagshipBooleanBinding)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
