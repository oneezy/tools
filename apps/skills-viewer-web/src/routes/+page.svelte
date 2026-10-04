<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import SkillMap from "#lib/SkillMap.svelte";
  import { formatRepo, parseRepoInput } from "#lib/repo.ts";
  import type { AnalyzeResult, ApiError } from "#lib/types.ts";

  const EXAMPLES = ["mattpocock/skills", "oneezy/skills", "anthropics/skills"];

  let input = $state(page.url.searchParams.get("repo") ?? "");
  let inputError = $state("");
  let status = $state<"idle" | "loading" | "done" | "error">("idle");
  let result = $state<AnalyzeResult | null>(null);
  let error = $state<ApiError | null>(null);

  const repoParam = $derived(page.url.searchParams.get("repo"));

  // the URL is the source of truth, so a pasted ?repo= link or Back loads that repo
  $effect(() => {
    if (repoParam) load(repoParam);
    else status = "idle";
  });

  async function load(repo: string) {
    input = repo;
    status = "loading";
    error = null;
    try {
      const res = await fetch(`/api/graph?repo=${encodeURIComponent(repo)}`);
      const body = await res.json();
      if (repoParam !== repo) return; // a newer search started
      if (!res.ok) {
        error = body as ApiError;
        status = "error";
        return;
      }
      result = body as AnalyzeResult;
      status = "done";
    } catch {
      error = { error: "Could not reach the server." };
      status = "error";
    }
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const parsed = parseRepoInput(input);
    if (!parsed) {
      inputError = "Paste owner/repo or a github.com link.";
      return;
    }
    inputError = "";
    goto(`?repo=${encodeURIComponent(formatRepo(parsed))}`, { reset: false });
  }

  function downloadJson() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result.graph, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${result.source.owner}-${result.source.repo}-graph.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const resetTime = (epoch?: number) =>
    epoch ? new Date(epoch * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
</script>

<svelte:head>
  <title>{result && status === "done" ? `${result.source.owner}/${result.source.repo} · Skills map` : "Skills map"}</title>
  <meta name="description" content="Paste a GitHub repo of agent skills and see how they connect." />
</svelte:head>

<main>
  <header class:compact={status !== "idle"}>
    <h1>Skills map</h1>
    <p class="lede">Paste a GitHub repo of agent skills or a plugin. See where to start and what calls what.</p>

    <form method="GET" onsubmit={submit}>
      <input
        name="repo"
        bind:value={input}
        type="text"
        inputmode="url"
        autocapitalize="off"
        autocomplete="off"
        spellcheck="false"
        placeholder="owner/repo or https://github.com/…"
        aria-label="GitHub repo"
        aria-invalid={inputError ? "true" : undefined}
      />
      <button type="submit" disabled={status === "loading"}>{status === "loading" ? "Reading…" : "Map it"}</button>
    </form>
    {#if inputError}<p class="error">{inputError}</p>{/if}

    {#if status === "idle"}
      <p class="examples">
        Try
        {#each EXAMPLES as ex, i}
          <a href={`?repo=${ex}`}>{ex}</a>{i < EXAMPLES.length - 1 ? ", " : ""}
        {/each}
      </p>
    {/if}
  </header>

  {#if status === "loading"}
    <p class="state">Fetching and reading the repo…</p>
  {:else if status === "error" && error}
    <div class="state error-box">
      <p>{error.error}</p>
      {#if error.rateLimitReset}<p class="muted">The limit resets at {resetTime(error.rateLimitReset)}.</p>{/if}
    </div>
  {:else if status === "done" && result}
    {@const g = result.graph}
    <section class="summary">
      <a class="repo" href={`https://github.com/${result.source.owner}/${result.source.repo}`} target="_blank" rel="noreferrer">
        {g.meta.roots[0]}
      </a>
      <span class="muted">@ {result.source.ref ?? "default branch"} · {result.source.sha}</span>
      <div class="stats">
        <span><b>{g.meta.skillCount}</b> skills</span>
        <span><b>{g.nodes.filter((n) => n.entry).length}</b> entry points</span>
        <span><b>{g.meta.edgeCount}</b> links</span>
        <span><b>{g.meta.flowCount}</b> flows</span>
        <button class="link" onclick={downloadJson}>graph.json</button>
      </div>
    </section>

    {#if g.nodes.length === 0}
      <p class="state">No SKILL.md files in this repo{result.source.subpath ? " folder" : ""}.</p>
    {:else}
      <SkillMap graph={g} blobBase={result.source.blobBase} />
    {/if}
  {/if}
</main>

<style>
  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px 16px 64px;
  }

  header {
    max-width: 640px;
    margin: 12vh auto 0;
    text-align: center;
    transition: margin 0.2s;
  }

  header.compact {
    margin-top: 0;
    max-width: none;
    text-align: left;
  }

  header.compact .lede {
    display: none;
  }

  h1 {
    margin: 0 0 4px;
    font-size: 1.75rem;
    letter-spacing: -0.02em;
  }

  header.compact h1 {
    font-size: 1.125rem;
  }

  .lede {
    margin: 0 0 20px;
    color: var(--muted);
  }

  form {
    display: flex;
    gap: 8px;
  }

  input {
    flex: 1;
    min-width: 0;
    padding: 12px 14px;
    font-size: 16px; /* 16px keeps iOS from zooming on focus */
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
  }

  input:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }

  button[type="submit"] {
    padding: 0 18px;
    border: 0;
    border-radius: var(--radius);
    background: var(--ink);
    color: var(--bg);
    font-weight: 600;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.6;
  }

  .examples {
    margin-top: 14px;
    color: var(--muted);
    font-size: 0.9rem;
  }

  .error {
    color: var(--danger);
    margin: 8px 0 0;
    font-size: 0.9rem;
  }

  .state {
    margin-top: 32px;
    color: var(--muted);
  }

  .error-box {
    padding: 12px 16px;
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    color: var(--ink);
  }

  .error-box p {
    margin: 0;
  }

  .muted {
    color: var(--muted);
  }

  .summary {
    margin: 20px 0 16px;
  }

  .repo {
    font-weight: 600;
    margin-right: 6px;
    overflow-wrap: anywhere;
  }

  .summary .muted {
    font-size: 0.85rem;
  }

  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    margin-top: 6px;
    font-size: 0.9rem;
    color: var(--muted);
  }

  .stats b {
    color: var(--ink);
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }
</style>
