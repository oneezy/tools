// Hermes's form: loose skills until its plugin probe passes (ADR-0007; notes/skills-68.md says plugins can work once
// the library renders a copy without metadata.internal). Until tools#153 lands, this module only says so; #153 makes it
// install each release plugin (`hermes plugins install oneezy/skills/<path>/<id>`), verify it, then remove the loose
// links, and flips formOf("hermes") in desired.ts to "github-plugins". Hermes's table row names no global instructions
// file, so no block is written there until that row says where one goes.
import { FORM_LABEL, formOf, type FormFn } from "../desired.js";

export const hermes: FormFn = (_release, state) => [
  {
    kind: "note",
    path: state.harness.name,
    note: `form: ${FORM_LABEL[formOf(state.harness.id)!]}; the plugin sync is not built yet (tools#153)`,
  },
];
