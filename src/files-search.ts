import ignore, { type Ignore } from "ignore";

/**
 * Invocation-local search visibility shared by Local and hosted Files.
 * Adapters supply bounded `.gitignore` text; `ignore` owns its grammar.
 * All paths here are canonical, root-relative paths with `/` separators;
 * the captured root itself is `""`. Exact reads do not use this policy.
 */
export class SearchVisibility {
  private readonly matchers = new Map<string, Ignore>();

  constructor(
    private readonly readGitignore: (
      directory: string,
    ) => Promise<string | undefined>,
  ) {}

  /** Check the search root and every entry with the same ancestor precedence. */
  async visible(path: string, isDirectory: boolean): Promise<boolean> {
    if (path === "") return true;
    const parts = path.split("/");
    if (parts.includes(".git")) return false;
    const layers: { base: string; matcher: Ignore }[] = [];
    for (let index = 0; index < parts.length; index++) {
      const base = parts.slice(0, index).join("/");
      layers.push({ base, matcher: await this.at(base) });
      const candidate = parts.slice(0, index + 1).join("/");
      const directory = index < parts.length - 1 || isDirectory;
      // Never reopen an excluded ancestor with a descendant's negation.
      for (const layer of layers.toReversed()) {
        const local =
          layer.base === ""
            ? candidate
            : candidate.slice(layer.base.length + 1);
        const verdict = layer.matcher.test(directory ? `${local}/` : local);
        if (verdict.ignored) return false;
        if (verdict.unignored) break;
      }
    }
    return true;
  }

  private async at(directory: string): Promise<Ignore> {
    const cached = this.matchers.get(directory);
    if (cached !== undefined) return cached;
    const content = await this.readGitignore(directory);
    const matcher = ignore();
    if (content !== undefined) matcher.add(content);
    this.matchers.set(directory, matcher);
    return matcher;
  }
}
