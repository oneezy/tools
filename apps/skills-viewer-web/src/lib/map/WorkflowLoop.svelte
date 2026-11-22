<script lang="ts">
  import { BaseEdge, type EdgeProps } from "@xyflow/svelte";
  let { id, sourceX, sourceY, targetX, targetY, markerEnd, style }: EdgeProps = $props();
  const path = $derived(`M ${sourceX} ${sourceY} C ${sourceX + 110} ${sourceY - 170}, ${targetX - 110} ${targetY - 170}, ${targetX} ${targetY}`);
</script>

<BaseEdge {id} {path} {markerEnd} {style} interactionWidth={20} />
