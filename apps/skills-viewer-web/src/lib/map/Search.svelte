<script lang="ts">
  import type { MapData } from "./data.ts";

  let { data, colors, onpick }: { data: MapData; colors: Map<string, number>; onpick: (id: string) => void } = $props();

  let q = $state("");
  let i = $state(0);
  const hits = $derived.by(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const inName = (id: string) => (id.toLowerCase().includes(s) ? 1 : 0);
    return data.nodes
      .filter((n) => n.id.toLowerCase().includes(s) || n.description.toLowerCase().includes(s))
      .sort((a, b) => inName(b.id) - inName(a.id))
      .slice(0, 8);
  });

  function pick(id: string) {
    onpick(id);
    q = "";
    (document.activeElement as HTMLElement | null)?.blur();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      i = Math.min(i + 1, hits.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      i = Math.max(i - 1, 0);
    } else if (e.key === "Enter" && hits[i]) pick(hits[i].id);
    else if (e.key === "Escape") q = "";
  }
</script>

<div class="search">
  <input
    id="skill-search"
    type="search"
    placeholder="Find a skill…"
    autocomplete="off"
    aria-label="Find a skill"
    bind:value={q}
    oninput={() => (i = 0)}
    {onkeydown}
  />
  {#if hits.length}
    <div class="panel results">
      {#each hits as n, j (n.id)}
        <button class="g{colors.get(n.group) ?? 0}" class:on={j === i} onmousedown={(e) => (e.preventDefault(), pick(n.id))}>
          <span class="dot"></span><span class="nm">{n.id}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
