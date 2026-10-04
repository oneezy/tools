<!--
  The board: full-screen Svelte Flow with floating chrome (top bar, key, zoom stack,
  layout switcher) and a detail panel (side panel on desktop, bottom sheet on phone).
  Must sit inside <SvelteFlowProvider> so useSvelteFlow works.
-->
<script lang="ts">
  import { Background, BackgroundVariant, MiniMap, SvelteFlow, useSvelteFlow, type Edge } from "@xyflow/svelte";
  import { onMount } from "svelte";
  import type { MapData } from "./data.ts";
  import Detail from "./Detail.svelte";
  import EdgeSwatch from "./EdgeSwatch.svelte";
  import FloatEdge from "./FloatEdge.svelte";
  import GroupBox from "./GroupBox.svelte";
  import { EDGE_TYPES } from "./labels.ts";
  import { CARD_H, CARD_W, LAYOUTS, layout, type LayoutKey, type MapFlowNode } from "./layouts.ts";
  import Search from "./Search.svelte";
  import SkillCard from "./SkillCard.svelte";

  let { data, title, blobBase }: { data: MapData; title: string; blobBase: string } = $props();

  const flow = useSvelteFlow();
  const nodeTypes = { skill: SkillCard, group: GroupBox };
  const edgeTypes = { float: FloatEdge };
  const LAYOUT_STORE = "skills-map-layout";

  let layoutKey = $state<LayoutKey>(readLayout());
  let nodes = $state.raw<MapFlowNode[]>([]);
  let busy = $state(true);
  let selected = $state<string | null>(null);
  let show = $state<Record<string, boolean>>({ calls: true, suggests: true, prerequisite: true, reference: true });
  let keyOpen = $state(false);
  let zoom = $state(1);
  let width = $state(1024);
  let height = $state(768);
  let fine = $state(true);

  const narrow = $derived(width <= 720);
  const colors = $derived(new Map(data.groups.map((g) => [g.key, g.color])));
  const current = $derived(LAYOUTS.find((l) => l.key === layoutKey)!);
  const counts = $derived(Object.fromEntries(EDGE_TYPES.map((t) => [t.key, data.edges.filter((e) => e.type === t.key).length])));

  function readLayout(): LayoutKey {
    try {
      const v = localStorage.getItem(LAYOUT_STORE);
      if (LAYOUTS.some((l) => l.key === v)) return v as LayoutKey;
    } catch {
      /* storage blocked */
    }
    return "libraries";
  }

  /** keep the fitted map clear of the floating chrome */
  const fitPadding = () =>
    narrow
      ? ({ top: "132px", bottom: "84px", left: "14px", right: "66px" } as const)
      : ({ top: "84px", bottom: "84px", left: "28px", right: "76px" } as const);
  const fit = (duration = 300) => flow.fitView({ padding: fitPadding(), duration });

  // re-lay out when the layout or the data changes; the viewport's shape is read once per run
  $effect(() => {
    const key = layoutKey;
    const d = data;
    let live = true;
    busy = true;
    selected = null;
    layout(key, d, window.innerWidth / window.innerHeight, fine)
      .then((ns) => {
        if (!live) return;
        nodes = ns;
        busy = false;
        setTimeout(() => fit(0), 60);
      })
      .catch((err) => {
        console.error(err);
        busy = false;
      });
    try {
      localStorage.setItem(LAYOUT_STORE, key);
    } catch {
      /* storage blocked */
    }
    return () => {
      live = false;
    };
  });

  const near = $derived.by(() => {
    if (!selected) return null;
    const s = new Set([selected]);
    for (const e of data.edges) {
      if (e.source === selected) s.add(e.target);
      if (e.target === selected) s.add(e.source);
    }
    return s;
  });

  const viewNodes = $derived(
    near ? nodes.map((n) => (n.type === "group" ? n : { ...n, class: n.id === selected ? "focus" : near.has(n.id) ? "" : "dim" })) : nodes,
  );

  const viewEdges = $derived<Edge[]>(
    data.edges.map((e) => {
      const touches = !!selected && (e.source === selected || e.target === selected);
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: "float",
        data: { type: e.type },
        hidden: !show[e.type] && !touches,
        class: selected ? (touches ? "hi" : "dim") : "",
        zIndex: touches ? 5 : 0,
        selectable: false,
        focusable: false,
      };
    }),
  );

  function cycle(d: number) {
    const i = LAYOUTS.findIndex((l) => l.key === layoutKey);
    layoutKey = LAYOUTS[(i + d + LAYOUTS.length) % LAYOUTS.length].key;
  }

  function focusOn(id: string) {
    selected = id;
    const n = flow.getInternalNode(id);
    if (!n) return;
    const x = n.internals.positionAbsolute.x + CARD_W / 2;
    const y = n.internals.positionAbsolute.y + CARD_H / 2;
    const z = Math.max(flow.getZoom(), 0.7);
    // keep the focused card clear of the side panel (desktop) or the bottom sheet (phone)
    flow.setCenter(x + (narrow ? 0 : 190 / z), y + (narrow ? (height * 0.22) / z : 0), { zoom: z, duration: 450 });
  }

  onMount(() => {
    fine = matchMedia("(pointer: fine)").matches;
    const typing = () => {
      const a = document.activeElement as HTMLElement | null;
      return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        flow.zoomIn({ duration: 150 });
      } else if (mod && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        flow.zoomOut({ duration: 150 });
      } else if (mod && e.key === "0") {
        e.preventDefault();
        fit();
      } else if (typing() || mod) return;
      else if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) {
        e.preventDefault();
        fit();
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById("skill-search")?.focus();
      } else if (e.key === "ArrowLeft") cycle(-1);
      else if (e.key === "ArrowRight") cycle(1);
      else if (e.key === "Escape") selected = null;
    };
    // stop iOS Safari zooming the page instead of the board
    const gesture = (e: Event) => e.preventDefault();
    window.addEventListener("keydown", onKey);
    document.addEventListener("gesturestart", gesture);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("gesturestart", gesture);
    };
  });

  const far = $derived(zoom < 0.6);
  const labelScale = $derived(Math.min(4.5, Math.max(1, 0.7 / zoom)));
  const nameSize = $derived(`${Math.min(28, Math.max(15, 11 / zoom)).toFixed(1)}px`);
  const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
</script>

<svelte:window bind:innerWidth={width} bind:innerHeight={height} />

<div
  class="board"
  class:far
  class:has-detail={!!selected}
  class:sheet-open={!!selected && narrow}
  style:--ls={labelScale}
  style:--nf={nameSize}
>
  <SvelteFlow
    bind:nodes={() => viewNodes, (v) => (nodes = v)}
    edges={viewEdges}
    {nodeTypes}
    {edgeTypes}
    onnodeclick={({ node }) => {
      if (node.type !== "skill") return;
      if (node.id === selected) selected = null;
      else focusOn(node.id);
    }}
    onpaneclick={() => (selected = null)}
    onmove={(_, vp) => (zoom = vp.zoom)}
    minZoom={0.04}
    maxZoom={2.5}
    panOnScroll
    zoomOnScroll={false}
    zoomOnPinch
    panOnDrag
    zoomOnDoubleClick
    elementsSelectable={false}
    nodesConnectable={false}
    nodesFocusable={false}
    edgesFocusable={false}
    attributionPosition="bottom-left"
  >
    <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} />
    {#if fine && !narrow}
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        style="bottom: 0"
        nodeColor={(n) => (n.type === "group" ? "transparent" : cssVar(`--g${n.data.color}`))}
        nodeStrokeColor={(n) => (n.type === "group" ? cssVar("--line") : "transparent")}
      />
    {/if}
  </SvelteFlow>

  <div class="chrome topbar">
    <div class="panel brand">
      <div class="brand-title"><a href="/" class="home" aria-label="Map another repo">←</a>{title}</div>
      <div class="brand-sub">
        {data.nodes.length} skills · {data.edges.length} links · {data.flows.length} flows{data.duplicates
          ? ` · ${data.duplicates} ${data.duplicates === 1 ? "copy" : "copies"} merged`
          : ""}
      </div>
    </div>
    <button class="keybtn" onclick={() => (keyOpen = !keyOpen)} aria-expanded={keyOpen}>{keyOpen ? "Hide key" : "Key"}</button>
    <Search {data} {colors} onpick={focusOn} />
  </div>

  {#if keyOpen}
    <div class="chrome panel key">
      <h3>Links</h3>
      {#each EDGE_TYPES as t (t.key)}
        <div class="key-row">
          <label for="show-{t.key}">
            <input id="show-{t.key}" type="checkbox" bind:checked={show[t.key]} />
            <EdgeSwatch kind={t.key} />{t.label}<span class="n">{counts[t.key]}</span>
          </label>
        </div>
      {/each}
      <h3>Libraries</h3>
      {#each data.groups as g (g.key)}
        <div class="key-row g{g.color}"><span class="dot"></span>{g.label}<span class="n">{g.count}</span></div>
      {/each}
      <div class="hint">
        {#if fine}
          Scroll to pan. <kbd>Ctrl</kbd> + scroll or <kbd>Ctrl</kbd> <kbd>+</kbd> / <kbd>−</kbd> to zoom.
          <kbd>Shift</kbd> <kbd>1</kbd> fits the map. <kbd>←</kbd> <kbd>→</kbd> switch layout. <kbd>/</kbd> finds a skill.
        {:else}
          Drag to pan, pinch to zoom, tap a skill to see what it links to.
        {/if}
      </div>
    </div>
  {/if}

  <div class="chrome panel zoom">
    <button onclick={() => flow.zoomIn({ duration: 150 })} aria-label="Zoom in">+</button>
    <div class="pct">{Math.round(zoom * 100)}%</div>
    <button onclick={() => flow.zoomOut({ duration: 150 })} aria-label="Zoom out">−</button>
    <button onclick={() => fit()} aria-label="Fit whole map" class="fit">⤢</button>
  </div>

  <div class="chrome switcher" role="group" aria-label="Layout">
    <button onclick={() => cycle(-1)} aria-label="Previous layout">‹</button>
    <div class="lbl"><b>{current.name}</b><span>{current.sub}</span></div>
    <button onclick={() => cycle(1)} aria-label="Next layout">›</button>
  </div>

  {#if busy}<div class="chrome panel busy">Laying out {data.nodes.length} skills…</div>{/if}
  {#if selected}
    <Detail id={selected} {data} {blobBase} {colors} onpick={focusOn} onclose={() => (selected = null)} />
  {/if}
</div>
