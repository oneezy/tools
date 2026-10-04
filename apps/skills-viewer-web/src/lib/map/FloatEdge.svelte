<!-- Border-to-border curved edge with its own arrowhead, so colours come from CSS vars in both themes. -->
<script lang="ts">
  import { BaseEdge, useInternalNode, type EdgeProps, type InternalNode } from "@xyflow/svelte";

  let { id, source, target, data }: EdgeProps = $props();
  // an edge keeps its endpoints for life, so reading them once is right
  // svelte-ignore state_referenced_locally
  const s = useInternalNode(source);
  // svelte-ignore state_referenced_locally
  const t = useInternalNode(target);
  const kind = $derived(String(data?.type ?? "calls"));

  /** where the line from a's centre to b's centre leaves a's rectangle */
  function border(a: InternalNode, b: InternalNode): [number, number] {
    const w = (a.measured.width ?? 0) / 2;
    const h = (a.measured.height ?? 0) / 2;
    const cx = a.internals.positionAbsolute.x + w;
    const cy = a.internals.positionAbsolute.y + h;
    const ox = b.internals.positionAbsolute.x + (b.measured.width ?? 0) / 2;
    const oy = b.internals.positionAbsolute.y + (b.measured.height ?? 0) / 2;
    const dx = ox - cx;
    const dy = oy - cy;
    const k = Math.min(Math.abs(dx) > 1e-6 ? w / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? h / Math.abs(dy) : Infinity);
    return [cx + dx * k, cy + dy * k];
  }

  const geo = $derived.by(() => {
    const a = s.current;
    const b = t.current;
    if (!a?.measured.width || !b?.measured.width) return null;
    const [sx, sy] = border(a, b);
    const [tx, ty] = border(b, a);
    const dx = tx - sx;
    const dy = ty - sy;
    const len = Math.hypot(dx, dy) || 1;
    const bend = Math.min(60, len * 0.12);
    const cx = (sx + tx) / 2 - (dy / len) * bend;
    const cy = (sy + ty) / 2 + (dx / len) * bend;
    const ang = Math.atan2(ty - cy, tx - cx);
    const A = 9;
    const p1 = [tx - A * Math.cos(ang - 0.42), ty - A * Math.sin(ang - 0.42)];
    const p2 = [tx - A * Math.cos(ang + 0.42), ty - A * Math.sin(ang + 0.42)];
    return { path: `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`, head: `M${tx},${ty} L${p1[0]},${p1[1]} L${p2[0]},${p2[1]} Z` };
  });
</script>

{#if geo}
  <BaseEdge {id} path={geo.path} class="ed ed-{kind}" interactionWidth={0} />
  <path d={geo.head} class="ah-{kind}" />
{/if}
