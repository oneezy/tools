import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite-plus";

export const libraryRoot = fileURLToPath(new URL("../../../packages/skills", import.meta.url));

export function localSkills(root = libraryRoot): Plugin {
  return {
    name: "local-skills",
    apply: "serve",
    async configureServer(server) {
      const { createLocalReader } = await import("./local-reader.ts");
      const read = createLocalReader(root);
      let revision = read().revision;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const roots = [
        path.join(root, "skills"),
        path.join(root, ".agents", "skills"),
        path.join(root, "skills-sync.json"),
        path.join(root, "skills-sync.lock.json"),
      ];
      server.watcher.add(roots);
      const changed = (_event: string, file: string) => {
        if (
          !roots.some((dir) => {
            const relative = path.relative(dir, file);
            return !relative.startsWith("..") && !path.isAbsolute(relative);
          })
        )
          return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            const next = read();
            if (next.revision === revision) return;
            revision = next.revision;
            server.ws.send({ type: "custom", event: "skills:changed", data: { revision } });
          } catch (error) {
            server.config.logger.error(`Local skills: ${String(error)}`);
            server.ws.send({ type: "custom", event: "skills:changed", data: { error: true } });
          }
        }, 200);
      };
      server.watcher.on("all", changed);
      server.httpServer?.once("close", () => {
        clearTimeout(timer);
        server.watcher.off("all", changed);
      });
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/api/local-skills") return next();
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json");
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "Only GET is supported." }));
          return;
        }
        // Only the fixed workspace source is exposed; never accept a filesystem path from a request.
        try {
          res.end(JSON.stringify(read()));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: `Could not read local skills: ${String(error)}` }));
        }
      });
    },
  };
}
