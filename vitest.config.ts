import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees under .claude/ hold full copies of the tree. Without this
    // their tests are collected alongside the real ones and every count is
    // doubled, which makes "did I break something" unanswerable.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
  },
});
