<!--
  Placeholder map: skills as cards in three bands (start here, called by others, the
  rest), each with its outgoing links. The zoomable canvas replaces this component.
-->
<script lang="ts">
  import type { Edge, EdgeType, Graph, Mode, SkillNode } from "./types.ts";

  let { graph, blobBase }: { graph: Graph; blobBase: string } = $props();

  const MODE_LABEL: Record<Mode, string> = { auto: "auto", manual: "manual only", background: "model only" };
  const EDGE_LABEL: Record<EdgeType, string> = {
    calls: "calls",
    prerequisite: "needs first",
    suggests: "suggests",
    reference: "mentions",
  };
  const EDGE_ORDER: EdgeType[] = ["calls", "prerequisite", "suggests", "reference"];

  const outgoing = $derived.by(() => {
    const m = new Map<string, Edge[]>();
    for (const e of graph.edges) m.set(e.source, [...(m.get(e.source) ?? []), e]);
    return m;
  });
  const incoming = $derived.by(() => {
    const m = new Map<string, number>();
    for (const e of graph.edges) m.set(e.target, (m.get(e.target) ?? 0) + 1);
    return m;
  });
  const bands = $derived([
    { title: "Start here", hint: "manual-only skills nothing else starts", nodes: graph.nodes.filter((n) => n.entry) },
    { title: "Called by other skills", hint: "sub-skills", nodes: graph.nodes.filter((n) => !n.entry && n.subSkill) },
    { title: "Everything else", hint: "", nodes: graph.nodes.filter((n) => !n.entry && !n.subSkill) },
  ]);

  let focused = $state<string | null>(null);

  function jump(id: string) {
    focused = id;
    document.getElementById(`skill-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function byType(edges: Edge[]) {
    return EDGE_ORDER.map((t) => ({ type: t, targets: edges.filter((e) => e.type === t).map((e) => e.target) })).filter(
      (g) => g.targets.length,
    );
  }

  const flowsOf = (n: SkillNode) => graph.flows.filter((f) => f.owner === n.id);
</script>

<p class="notice">Placeholder layout. The zoomable canvas is being built.</p>

<div class="legend">
  {#each Object.entries(MODE_LABEL) as [mode, label]}
    <span><i class="dot {mode}"></i>{label}</span>
  {/each}
</div>

{#each bands as band}
  {#if band.nodes.length}
    <section>
      <h2>{band.title} <span class="count">{band.nodes.length}</span></h2>
      {#if band.hint}<p class="hint">{band.hint}</p>{/if}
      <div class="grid">
        {#each band.nodes as n (n.id)}
          <article id="skill-{n.id}" class:focused={focused === n.id}>
            <div class="title">
              <i class="dot {n.mode}" title={MODE_LABEL[n.mode]}></i>
              <h3>{n.name}</h3>
              <a class="file" href="{blobBase}/{n.file}" target="_blank" rel="noreferrer">SKILL.md</a>
            </div>
            {#if n.description}<p class="desc">{n.description}</p>{/if}

            {#each byType(outgoing.get(n.id) ?? []) as g}
              <div class="edges">
                <span class="etype {g.type}">{EDGE_LABEL[g.type]}</span>
                {#each g.targets as t}
                  <button onclick={() => jump(t)}>{t}</button>
                {/each}
              </div>
            {/each}

            {#each flowsOf(n) as f}
              <div class="flow">
                <span class="etype">{f.kind}</span>
                {f.steps.join(f.kind === "parallel" ? " ‖ " : " → ")}{f.until ? ` ↺ until ${f.until}` : ""}
              </div>
            {/each}

            {#if (incoming.get(n.id) ?? 0) > 0 || n.scripts.length || n.references.length}
              <p class="meta">
                {#if incoming.get(n.id)}{incoming.get(n.id)} incoming{/if}
                {#if n.scripts.length} · {n.scripts.length} scripts{/if}
                {#if n.references.length} · {n.references.length} references{/if}
              </p>
            {/if}
          </article>
        {/each}
      </div>
    </section>
  {/if}
{/each}

<style>
  .notice {
    margin: 0 0 8px;
    font-size: 0.8rem;
    color: var(--muted);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: 0.8rem;
    color: var(--muted);
  }

  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  section {
    margin-top: 28px;
  }

  h2 {
    margin: 0;
    font-size: 1rem;
  }

  .count {
    color: var(--muted);
    font-weight: 400;
  }

  .hint {
    margin: 0;
    font-size: 0.8rem;
    color: var(--muted);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
    align-items: start;
    gap: 12px;
    margin-top: 12px;
  }

  article {
    padding: 14px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    scroll-margin: 80px;
    transition: border-color 0.2s;
  }

  article.focused {
    border-color: var(--accent);
    outline: 2px solid var(--accent);
  }

  .title {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  h3 {
    flex: 1;
    margin: 0;
    font-size: 0.95rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow-wrap: anywhere;
  }

  .file {
    font-size: 0.75rem;
  }

  .desc {
    margin: 6px 0 0;
    font-size: 0.85rem;
    color: var(--muted);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--auto);
  }

  .dot.manual {
    background: var(--manual);
  }

  .dot.background {
    background: var(--background);
  }

  .edges,
  .flow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    font-size: 0.8rem;
  }

  .flow {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .etype {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    font-family: inherit;
  }

  .etype.calls,
  .etype.prerequisite {
    color: var(--ink);
    font-weight: 600;
  }

  .edges button {
    padding: 4px 9px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: transparent;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
    cursor: pointer;
  }

  .edges button:hover {
    border-color: var(--accent);
  }

  .meta {
    margin: 8px 0 0;
    font-size: 0.75rem;
    color: var(--muted);
  }
</style>
