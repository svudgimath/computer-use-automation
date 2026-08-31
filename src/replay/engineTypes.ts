// Split out from engine.ts so template.ts and checkpoint.ts can depend on the
// type without an import cycle back into engine.ts.
export type ReplayParams = Record<string, string | number | boolean>;
