<script lang="ts">
  import { SvelteFlowProvider } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/base.css";
  import type { Graph } from "../types.ts";
  import "./canvas.css";
  import Canvas from "./Canvas.svelte";
  import WorkflowCanvas from "./WorkflowCanvas.svelte";
  import { toMapData } from "./data.ts";

  let { graph, title, repoName, blobBase }: { graph: Graph; title: string; repoName: string; blobBase: string } = $props();
  let workflow = $state<{ id: string; source: string } | null>(null);

  const data = $derived(toMapData(graph, repoName));
  const preferenceKey = $derived(`skills-map-visibility:${graph.meta.source.kind === "local" ? "local" : `${graph.meta.source.owner}/${graph.meta.source.repo}/${graph.meta.source.subpath ?? ""}`}`);
</script>

{#key preferenceKey}
  {#if workflow?.source === preferenceKey}
    <SvelteFlowProvider><WorkflowCanvas {graph} root={workflow.id} {blobBase} onclose={() => workflow = null} /></SvelteFlowProvider>
  {:else}
    <SvelteFlowProvider><Canvas {data} {title} {blobBase} {preferenceKey} onworkflow={id => workflow = { id, source: preferenceKey }} /></SvelteFlowProvider>
  {/if}
{/key}
