import type { Pull } from "../../../skills/skills/oneezy/oneezy-task-manager/scripts/steps/board.ts";
import type {
  Api,
  Repo,
  Project,
  Issue,
  Item,
} from "../../../skills/skills/oneezy/oneezy-task-manager/scripts/types.ts";
export class FakeGitHub implements Api {
  calls: {
    kind: string;
    method?: string;
    path?: string;
    body?: Record<string, unknown>;
    query?: string;
    variables?: Record<string, unknown>;
  }[];
  repo: Repo;
  project: Project;
  issues: Issue[];
  items: Item[];
  labels: { name: string; color: string; description: string }[];
  milestones: { number: number; title: string; description: string }[];
  pull: {
    headRefName: string;
    body: string;
    closingIssuesReferences: {
      nodes: { number: number; repository: { nameWithOwner: string } }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  caller: string;
  pulls: Pull[];
  branches: string[];
  inDev: Set<string>;
  rest<T>(method: string, path: string, body?: unknown): Promise<T>;
  pages<T>(path: string): Promise<T[]>;
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}
