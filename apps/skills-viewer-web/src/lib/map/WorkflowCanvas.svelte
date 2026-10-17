<script lang="ts">
  import { Background, BackgroundVariant, MarkerType, SvelteFlow, useSvelteFlow, type Node, type Edge } from "@xyflow/svelte";
  import type { Graph, WorkflowEvidence } from "skills-viewer";
  import { tick } from "svelte";
  import { getElk } from "./layouts.ts";
  import { buildWorkflow, type WorkflowCardData } from "./workflow.ts";
  import WorkflowCard from "./WorkflowCard.svelte";
  import WorkflowLoop from "./WorkflowLoop.svelte";

  let { graph, root, blobBase, onclose }: { graph: Graph; root: string; blobBase: string; onclose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  let expanded = $state(new Set([root]));
  // svelte-ignore state_referenced_locally
  let activeRoot = $state(root);
  let files = $state(true);
  let nodes = $state.raw<Node<WorkflowCardData>[]>([]);
  let busy = $state(false);
  let error = $state("");
  let selected = $state<string | null>(null);
  let edgeEvidence = $state<WorkflowEvidence | null>(null);
  const flow = useSvelteFlow();
  const view = $derived(buildWorkflow(graph, activeRoot, expanded, files));
  const docs = $derived(new Map((graph.workflows ?? []).map(d => [d.id, d])));
  const selection = $derived(view.nodes.find(n => n.id === selected)?.data);
  const document = $derived(selection?.document ? docs.get(selection.document) : undefined);
  const proof = $derived(edgeEvidence ?? selection?.evidence);
  const name = $derived(docs.get(activeRoot)?.label ?? root);
  const nodeTypes = { workflow: WorkflowCard };
  const edgeTypes = { loop: WorkflowLoop };
  const fit = () => flow.fitView({ padding: 0.15, duration: 250, maxZoom: 1 });

  const edges = $derived<Edge[]>(view.edges.map(e => ({
    id: e.id, source: e.source, target: e.target, type: e.source === e.target ? "loop" : "smoothstep", label: e.kind === "repeat" ? "↻ repeat" : e.label,
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--muted)" },
    style: `stroke: var(${e.kind === "repeat" || e.kind === "recursive" ? "--accent" : "--muted"}); stroke-width: 1.5; ${e.kind === "reference" || e.kind === "recursive" ? "stroke-dasharray: 5 4;" : ""}`,
    labelStyle: "fill: var(--ink); font-size: 11px;", labelBgStyle: "fill: var(--surface);", labelBgPadding: [5, 3],
  })));

  $effect(() => {
    const current = view;
    let live = true;
    busy = true;
    error = "";
    getElk().then(elk => elk.layout({
      id: "workflow", layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "70", "elk.layered.spacing.nodeNodeBetweenLayers": "110" },
      children: current.nodes.map(n => ({ id: n.id, width: 270, height: 132 })),
      edges: current.edges.filter(e => e.kind !== "repeat" && e.kind !== "recursive").map(e => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    })).then(async result => {
      if (!live) return;
      const positions = new Map(result.children?.map(n => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
      nodes = current.nodes.map(n => ({ ...n, data: $state.snapshot(n.data), type: "workflow", position: positions.get(n.id) ?? { x: 0, y: 0 }, width: 270, height: 132 }));
      busy = false;
      await tick();
      if (live) fit();
    }).catch(err => { if (live) { busy = false; error = String(err); } });
    return () => { live = false; };
  });

  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    expanded = next;
  }
  function openFile(id: string) {
    activeRoot = id;
    expanded = new Set([id]);
    selected = null;
    edgeEvidence = null;
  }
  const sourceUrl = (file: string, line?: number) => `${blobBase.replace(/\/$/, "")}/${file.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`;
</script>

<div class="board workflow-board">
  <header class="wf-toolbar">
    <button onclick={onclose}>← Libraries</button>
    <div class="wf-title"><b>{name}</b><span>Workflow · static analysis</span></div>
    {#if activeRoot !== root}<button onclick={() => openFile(root)}>Back to skill</button>{/if}
    <label><input type="checkbox" bind:checked={files} /> Files</label>
    <button onclick={() => { expanded = new Set([activeRoot]); selected = null; edgeEvidence = null; }}>Reset</button>
    <button onclick={fit}>Fit</button>
  </header>
  <div class="wf-map">
    <SvelteFlow {nodes} {edges} {nodeTypes} {edgeTypes} minZoom={0.08} maxZoom={2} nodesConnectable={false}
      onnodeclick={({ node }) => { selected = node.id; edgeEvidence = null; }}
      onedgeclick={({ edge }) => { edgeEvidence = view.edges.find(e => e.id === edge.id)?.evidence ?? null; selected = null; }}
      onpaneclick={() => { selected = null; edgeEvidence = null; }}>
      <Background variant={BackgroundVariant.Dots} gap={24} />
    </SvelteFlow>
  </div>
  <div class="wf-note">Solid arrows: detected steps. Dashed arrows: relationships, not execution order.
    {#if view.truncated}<strong>Showing the first 250 nodes. Collapse a branch to explore another.</strong>{/if}
    {#if busy}<span role="status"> Laying out workflow…</span>{/if}
    {#if error}<span role="alert">{error}</span>{/if}
    {#if !view.nodes.length}<span>This skill is no longer available, or this graph predates workflow analysis.</span>{/if}
  </div>
  {#if selection || proof}
    <aside class="wf-detail" aria-label="Workflow details">
      <button class="wf-close" aria-label="Close workflow details" onclick={() => { selected = null; edgeEvidence = null; }}>×</button>
      {#if selection}
        <small>{selection.library} / {selection.kind}{selection.number ? ` ${selection.number}` : ""}</small>
        <h3>{selection.label}</h3>
        {#if selection.description}<p>{selection.description}</p>{/if}
      {/if}
      {#if document}
        <button onclick={() => toggle(document.id)}>{expanded.has(document.id) ? "Collapse" : "Expand"} {document.kind}</button>
        <p>{document.references.length} references · {document.sequences.length} detected step lists</p>
        {#if document.children.length && document.kind === "skill"}
          <details><summary>Available files ({document.children.length})</summary>
            <p>These files belong to this skill. Their presence does not imply that they run.</p>
            {#each document.children as id}
              <button class="wf-file" onclick={() => openFile(id)}>{docs.get(id)?.label ?? id}</button>
            {/each}
          </details>
        {/if}
      {/if}
      {#if proof}
        <h4>Source evidence</h4>
        {#if blobBase}<a href={sourceUrl(proof.file, proof.line)} target="_blank" rel="noreferrer">{proof.file}:{proof.line}</a>
        {:else}<code>{proof.file}:{proof.line}</code>{/if}
        <blockquote>{proof.snippet}</blockquote><small>Rule: {proof.rule}</small>
      {:else if document}<code>{document.file}</code>{/if}
    </aside>
  {/if}
</div>

<style>
  .workflow-board { display: flex; flex-direction: column; }
  .wf-toolbar { display: flex; gap: 12px; align-items: center; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--surface); }
  .wf-toolbar button, .wf-detail button { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
  .wf-title { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .wf-title b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wf-title span, small { font-size: 11px; color: var(--muted); }
  .wf-toolbar label { white-space: nowrap; }
  .wf-map { flex: 1; min-height: 0; }
  .wf-note { padding: 8px 16px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--line); }
  .wf-note strong { display: block; color: var(--ink); }
  .wf-detail { position: absolute; top: 85px; right: 16px; width: 340px; max-height: calc(100% - 150px); overflow: auto; padding: 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow); z-index: 10; overflow-wrap: anywhere; }
  .wf-detail h3 { margin: 8px 25px 12px 0; }
  .wf-detail p { color: var(--muted); font-size: 13px; }
  .wf-detail code, .wf-detail a { font-size: 11px; }
  .wf-close { float: right; }
  blockquote { margin: 12px 0; border-left: 2px solid var(--accent); padding-left: 12px; white-space: pre-wrap; font-size: 13px; }
  .wf-file { display: block; width: 100%; margin: 4px 0; text-align: left; font-size: 12px; }
  @media (max-width: 720px) {
    .wf-toolbar { padding: 8px; gap: 8px; flex-wrap: wrap; }
    .wf-title { flex-basis: calc(100% - 130px); }
    .wf-detail { top: auto; bottom: 48px; left: 8px; right: 8px; width: auto; max-height: 42%; padding: 14px; }
    .wf-note { font-size: 10px; }
  }
</style>
