// Claude Code's form: the account plugins claude.ai delivers as <id>@synced (ADR-0007). Until tools#149 lands, this
// module only says so; #149 makes it compare state.synced with the release, remove a tool-installed plugin of the same
// name once the account plugin is verified present, remove loose links that duplicate its skills, and report a plugin
// the account does not deliver as a manual step. It returns actions only: desired.ts puts them in the plan, apply()
// runs them, and plugin commands go through install.ts's drivers, recorded as install/uninstall actions.
import { FORM_LABEL, formOf, type FormFn } from "../desired.js";

export const claudeCode: FormFn = (_release, state) => [
  {
    kind: "note",
    path: state.harness.name,
    note: `form: ${FORM_LABEL[formOf(state.harness.id)!]}; the account-plugin sync is not built yet (tools#149)`,
  },
];
