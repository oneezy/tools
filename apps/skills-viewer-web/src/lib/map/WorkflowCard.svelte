<script lang="ts">
  import { Handle, Position, type Node, type NodeProps } from "@xyflow/svelte";
  import type { WorkflowCardData } from "./workflow.ts";
  let { data }: NodeProps<Node<WorkflowCardData>> = $props();
</script>

<div class="workflow-card" style:--wc={`var(--g${data.color})`}>
  <Handle type="target" position={Position.Left} class="hd" isConnectable={false} />
  <div class="wf-meta"><span>{data.number ? `${data.number} · ` : ""}{data.library}</span><span>{data.kind}</span></div>
  <div class="wf-name" title={data.label}>{data.label}</div>
  {#if data.description}<div class="wf-description">{data.description}</div>{/if}
  {#if data.document}<span class="wf-action">{data.expanded ? "Expanded · click for details" : "Click to inspect and expand"}</span>{/if}
  <Handle type="source" position={Position.Right} class="hd" isConnectable={false} />
</div>

<style>
  .workflow-card { width: 270px; height: 132px; padding: 12px 14px; border: 1px solid var(--line); border-left: 4px solid var(--wc); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 6px; }
  .wf-meta { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; color: var(--wc); }
  .wf-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wf-name { font-weight: 650; font-size: 15px; line-height: 1.3; overflow: hidden; display: -webkit-box; line-clamp: 2; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .wf-description { font-size: 11px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .wf-action { font-size: 10px; color: var(--muted); margin-top: auto; }
</style>
