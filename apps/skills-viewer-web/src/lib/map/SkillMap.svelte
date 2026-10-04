<script lang="ts">
  import { SvelteFlowProvider } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/base.css";
  import type { Graph } from "../types.ts";
  import "./canvas.css";
  import Canvas from "./Canvas.svelte";
  import { toMapData } from "./data.ts";

  let { graph, title, repoName, blobBase }: { graph: Graph; title: string; repoName: string; blobBase: string } = $props();

  const data = $derived(toMapData(graph, repoName));
</script>

<SvelteFlowProvider>
  <Canvas {data} {title} {blobBase} />
</SvelteFlowProvider>
