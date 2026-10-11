// One form per harness (ADR-0007): the plugin form wherever the harness has a plugin route, the loose-skill form only
// where it has none. Claude Code gets the account plugins claude.ai delivers, Codex the library's marketplace from
// GitHub, Hermes loose skills until its plugin probe passes. Goose is dropped. The desired state per harness (what
// sync compares the probe with) and the plan it produces join this file as the sync tickets land.

export type MachineForm = "account-plugins" | "github-plugins" | "loose";

/** What a user reads for each form. */
export const FORM_LABEL: Record<MachineForm, string> = {
  "account-plugins": "account plugins",
  "github-plugins": "plugins from GitHub",
  loose: "loose skills",
};

/** The form a harness gets; null for a harness this tool no longer serves. */
export function formOf(harnessId: string): MachineForm | null {
  switch (harnessId) {
    case "claude-code":
      return "account-plugins";
    case "codex":
      return "github-plugins";
    case "hermes":
      return "loose";
    default:
      return null;
  }
}
