<script lang="ts">
  import type { Node, NodeProps } from "@xyflow/svelte";
  import type { GroupNodeData } from "./layouts.ts";

  let { data }: NodeProps<Node<GroupNodeData, "group">> = $props();
</script>

<div class="grp g{data.color}" class:fam={data.family}>
  <div class="grp-label">
    <span class="grp-name">{data.label}</span>
    <span class="grp-count">{data.count} skills</span>
  </div>
</div>
