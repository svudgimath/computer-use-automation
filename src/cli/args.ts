// Tiny manual flag parser -- no dependency needed for a handful of flags.
// Supports --flag value and repeatable --flag value --flag value2.

export function parseArgs(argv: string[]): { flags: Record<string, string>; repeated: Record<string, string[]> } {
  const flags: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    flags[key] = value;
    (repeated[key] ??= []).push(value);
  }
  return { flags, repeated };
}
