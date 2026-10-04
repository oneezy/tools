<script lang="ts">
  import { Handle, Position, type Node, type NodeProps } from "@xyflow/svelte";
  import type { SkillNodeData } from "./layouts.ts";

  let { data }: NodeProps<Node<SkillNodeData, "skill">> = $props();
  const s = $derived(data.skill);
  // break long names only at hyphens
  const parts = $derived(s.id.split("-"));
</script>

<div class="sk g{data.color}" class:manual={s.manual}>
  <Handle type="target" position={Position.Left} class="hd" isConnectable={false} />
  <div class="sk-top">
    <span class="sk-name">{#each parts as p, i}{#if i}<wbr />-{/if}{p}{/each}</span>
    {#if s.loop}<span class="badge loop" title="part of a loop">↻ loop</span>{/if}
    {#if s.entry}<span class="badge start">start</span>{/if}
  </div>
  <div class="sk-desc">{s.short}</div>
  <div class="sk-meta">
    <span>{s.manual ? "slash only" : "auto + slash"}</span>
    <span>↗ {s.out} out</span>
    <span>↙ {s.in} in</span>
  </div>
  <Handle type="source" position={Position.Right} class="hd" isConnectable={false} />
</div>
