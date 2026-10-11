// Codex's form: the library's plugins from the GitHub marketplace oneezy/skills (ADR-0007). Until tools#150 lands, this
// module only says so; #150 makes it add the marketplace (`codex plugin marketplace add oneezy/skills`), install each
// release plugin, verify it, then remove the loose links and the library copies in ~/.codex/skills (never .system),
// listing other folders there for adopt-or-delete. Shapes of the Codex commands: notes/skills-66.md.
import { FORM_LABEL, formOf, type FormFn } from "../desired.js";

export const codex: FormFn = (_release, state) => [
  {
    kind: "note",
    path: state.harness.name,
    note: `form: ${FORM_LABEL[formOf(state.harness.id)!]}; the marketplace sync is not built yet (tools#150)`,
  },
];
