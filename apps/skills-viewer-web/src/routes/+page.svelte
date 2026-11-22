<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import SkillMap from "#lib/map/SkillMap.svelte";
  import { formatRepo, parseRepoInput } from "#lib/repo.ts";
  import type { AnalyzeResult, ApiError } from "#lib/types.ts";

  const EXAMPLES = ["mattpocock/skills", "oneezy/skills", "anthropics/skills"];

  let input = $state(page.url.searchParams.get("repo") ?? "");
  let inputError = $state("");
  let status = $state<"idle" | "loading" | "done" | "error">("idle");
  let result = $state<AnalyzeResult | null>(null);
  let error = $state<ApiError | null>(null);
  let updating = $state(false);
  let connected = $state(true);
  let mounted = $state(false);
  let request = 0;
  let controller: AbortController | undefined;

  const repoParam = $derived(page.url.searchParams.get("repo"));
  const localAvailable = import.meta.env.DEV;
  const mode = $derived(localAvailable && page.url.searchParams.get("source") !== "web" && !repoParam ? "local" : "web");
  const src = $derived(result?.graph.meta.source.kind === "github" ? result.graph.meta.source : null);
  const mapTitle = $derived(mode === "local" ? "Local skills" : src ? `${src.owner}/${src.repo}${src.subpath ? `/${src.subpath}` : ""}` : "");

  // the URL is the source of truth, so a pasted ?repo= link or Back loads that repo
  $effect(() => {
    if (!mounted) return;
    const source = mode;
    const repo = repoParam;
    if (source === "local") loadLocal();
    else if (repo) load(repo);
    else {
      controller?.abort();
      request++;
      result = null;
      error = null;
      status = "idle";
    }
  });

  onMount(() => {
    mounted = true;
    const changed = () => { if (mode === "local") void loadLocal(true); };
    const disconnected = () => { connected = false; };
    const reconnected = () => { connected = true; changed(); };
    import.meta.hot?.on("skills:changed", changed);
    import.meta.hot?.on("vite:ws:disconnect", disconnected);
    import.meta.hot?.on("vite:ws:connect", reconnected);
    return () => {
      mounted = false;
      request++;
      controller?.abort();
      import.meta.hot?.off("skills:changed", changed);
      import.meta.hot?.off("vite:ws:disconnect", disconnected);
      import.meta.hot?.off("vite:ws:connect", reconnected);
    };
  });

  async function loadLocal(background = false) {
    const id = ++request;
    controller?.abort();
    controller = new AbortController();
    if (!background) status = "loading";
    updating = true;
    error = null;
    try {
      const res = await fetch("/api/local-skills", { signal: controller.signal });
      const body = await res.json();
      if (id !== request) return;
      if (!res.ok) throw new Error((body as ApiError).error);
      result = body as AnalyzeResult;
      status = "done";
    } catch (err) {
      if (id !== request) return;
      error = { error: err instanceof Error ? err.message : "Could not read local skills." };
      status = "error";
    } finally {
      if (id === request) updating = false;
    }
  }

  async function load(repo: string) {
    const id = ++request;
    controller?.abort();
    controller = new AbortController();
    input = repo;
    status = "loading";
    error = null;
    try {
      const res = await fetch(`/api/graph?repo=${encodeURIComponent(repo)}&analysis=workflow-v1`, { signal: controller.signal });
      const body = await res.json();
      if (id !== request) return;
      if (!res.ok) {
        error = body as ApiError;
        status = "error";
        return;
      }
      result = body as AnalyzeResult;
      status = "done";
    } catch {
      if (id !== request) return;
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
    a.download = `${mapTitle.replaceAll("/", "-")}-graph.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const resetTime = (epoch?: number) =>
    epoch ? new Date(epoch * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
</script>

<svelte:head>
  <title>{status === "done" && mapTitle ? `${mapTitle} · Skills map` : "Skills map"}</title>
  <meta name="description" content="Paste a GitHub repo of agent skills and see how they connect." />
</svelte:head>

{#if localAvailable}
  <nav class="source-bar" aria-label="Skill source">
    <div class="source-options">
      <a href="?source=local" aria-current={mode === "local" ? "page" : undefined}>Local</a>
      <a href="?source=web" aria-current={mode === "web" ? "page" : undefined}>Web</a>
    </div>
    {#if mode === "local"}
      <span class="folder">packages/skills</span>
      <span class="live" role="status">{!connected ? "Disconnected" : status === "error" ? "Needs attention" : updating ? "Updating…" : "Watching"}</span>
    {/if}
  </nav>
{/if}

<div class:with-source={localAvailable}>
{#if status === "done" && result && result.graph.nodes.length}
  <SkillMap
    graph={result.graph}
    title={mapTitle}
    repoName={src?.repo ?? "skills"}
    blobBase={src?.blobBase ?? ""}
  />
{:else}
  <main>
    <header class:compact={status !== "idle"}>
      <h1>Skills map</h1>
      <p class="lede">{mode === "local" ? "Your local skills, updated as you save." : "Paste a GitHub repo of agent skills or a plugin. See where to start and what calls what."}</p>

      {#if mode === "web"}
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
      {/if}
    </header>

    {#if status === "loading"}
      <p class="state">{mode === "local" ? "Reading local skills…" : "Fetching and reading the repo…"}</p>
    {:else if status === "error" && error}
      <div class="state error-box">
        <p>{error.error}</p>
        {#if error.rateLimitReset}<p class="muted">The limit resets at {resetTime(error.rateLimitReset)}.</p>{/if}
      </div>
    {:else if status === "done" && result}
      <p class="state">
        No SKILL.md files in {mapTitle}.
        <button class="link" onclick={downloadJson}>graph.json</button>
      </p>
    {/if}
  </main>
{/if}
</div>

<style>
  .source-bar { position: fixed; inset: 0 0 auto; height: 56px; display: flex; align-items: center; gap: 16px; padding: 0 16px; background: var(--surface); border-bottom: 1px solid var(--line); z-index: 50; }
  .source-options { display: flex; gap: 4px; }
  .source-options a { padding: 7px 14px; border-radius: var(--radius); color: var(--muted); text-decoration: none; }
  .source-options a[aria-current] { background: var(--ink); color: var(--bg); }
  .folder, .live { font-size: 0.85rem; color: var(--muted); }
  .live { margin-left: auto; }
  .with-source { padding-top: 56px; }
  .with-source :global(.board) { top: 56px; height: calc(100dvh - 56px); }
  @media (max-width: 480px) { .source-bar { gap: 8px; padding: 0 8px; } .folder { font-size: 0.75rem; } }
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






  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }
</style>
