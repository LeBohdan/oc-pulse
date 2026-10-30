/**
 * (c) Bohdan Futerko, 2026, https://www.bf.com.ua, https://github.com/LeBohdan
 */
import { Plugin } from "@opencode/plugin"

// Server-side entry is a no-op: oc-pulse is a TUI-only plugin (see ./tui).
const plugin = Plugin.define({
  id: "oc-pulse",
  setup() {},
})

export default plugin
