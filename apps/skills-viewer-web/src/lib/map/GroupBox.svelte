<script lang="ts">
  import type { Node, NodeProps } from "@xyflow/svelte";
  import type { GroupNodeData } from "./layouts.ts";

  let { data }: NodeProps<Node<GroupNodeData, "group">> = $props();

  const NAMES: Record<string, [string, string]> = {
    command: ["command", "commands"],
    agent: ["agent", "agents"],
    hook: ["hook", "hooks"],
    mcp: ["MCP server", "MCP servers"],
    script: ["script", "scripts"],
    reference: ["file", "files"],
    asset: ["asset", "assets"],
  };
  const extra = $derived(
    Object.entries(data.parts)
      .map(([k, n]) => `${n} ${(NAMES[k] ?? [k, k])[n === 1 ? 0 : 1]}`)
      .join(" · "),
  );
</script>

<div class="grp g{data.color}" class:fam={data.family}>
  <div class="grp-label">
    <span class="grp-name">{data.label}</span>
    <span class="grp-count">{data.count} skills{extra ? ` · ${extra}` : ""}</span>
  </div>
</div>
