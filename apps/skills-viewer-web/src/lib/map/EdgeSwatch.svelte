<script lang="ts">
  let { kind }: { kind: string } = $props();
</script>

<svg width="30" height="10" aria-hidden="true">
  <path d="M2,5 L22,5" class="ed ed-{kind}" />
  <path d="M28,5 L21,1.5 L21,8.5 Z" class="ah-{kind}" />
</svg>
