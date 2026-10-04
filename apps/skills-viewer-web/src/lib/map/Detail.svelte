<script lang="ts">
  import type { MapData, MapEdge } from "./data.ts";
  import EdgeSwatch from "./EdgeSwatch.svelte";
  import { EDGE_TYPES, plain } from "./labels.ts";

  let {
    id,
    data,
    blobBase,
    colors,
    onpick,
    onclose,
  }: {
    id: string;
    data: MapData;
    blobBase: string;
    colors: Map<string, number>;
    onpick: (id: string) => void;
    onclose: () => void;
  } = $props();

  const n = $derived(data.nodes.find((x) => x.id === id)!);
  const out = $derived(data.edges.filter((e) => e.source === id));
  const inc = $derived(data.edges.filter((e) => e.target === id));
  const flows = $derived(data.flows.filter((f) => f.owner === id || f.steps.includes(id)));
  const sections = $derived([
    ...EDGE_TYPES.map((t) => ({ title: t.label, kind: t.key as string | null, list: out.filter((e) => e.type === t.key), other: "target" as const })),
    { title: "Used by", kind: null, list: inc, other: "source" as const },
  ]);
  const colorOf = (sid: string) => colors.get(data.nodes.find((x) => x.id === sid)?.group ?? "") ?? 0;
  const first = (e: MapEdge) => e.evidence[0];
</script>

<aside class="chrome panel detail" aria-label="Skill details">
  <div class="d-head">
    <div class="t">
      <div class="d-name">{n.manual ? "/" : ""}{n.id}</div>
      <div class="chips">
        <span class="chip lib g{colorOf(n.id)}">{n.group}</span>
        <span class="chip">{n.manual ? "slash only" : "auto + slash"}</span>
        {#if n.entry}<span class="chip">entry point</span>{/if}
        <span class="chip">{n.lines} lines</span>
        {#if n.references}<span class="chip">{n.references} reference files</span>{/if}
        {#if n.scripts}<span class="chip">{n.scripts} scripts</span>{/if}
      </div>
    </div>
    <button class="close" onclick={onclose} aria-label="Close details">×</button>
  </div>
  <div class="d-body">
    <p class="d-desc">{n.description}</p>
    {#each sections as sec (sec.title)}
      {#if sec.list.length}
        <div class="d-sec">
          <h4>{#if sec.kind}<EdgeSwatch kind={sec.kind} />{/if}{sec.title} · {sec.list.length}</h4>
          <div class="lk">
            {#each sec.list as e (e.id)}
              <button onclick={() => onpick(e[sec.other])}>
                <span class="row g{colorOf(e[sec.other])}">
                  <span class="dot"></span><span class="nm">{e[sec.other]}</span>
                  {#if first(e)}<span class="ln">line {first(e).line}</span>{/if}
                </span>
                {#if first(e)}<span class="ev">{plain(first(e).snippet)}</span>{/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    {/each}
    {#if flows.length}
      <div class="d-sec">
        <h4>Flows · {flows.length}</h4>
        <div class="lk">
          {#each flows as f, i (i)}
            <div class="flow">
              <b>{f.kind} · in {f.owner}</b>
              {f.steps.join(f.kind === "parallel" ? " ‖ " : " → ")}{f.until ? ` (until ${plain(f.until)})` : ""}
            </div>
          {/each}
        </div>
      </div>
    {/if}
    <a class="path" href="{blobBase}/{n.file}" target="_blank" rel="noreferrer">{n.file}</a>
  </div>
</aside>
