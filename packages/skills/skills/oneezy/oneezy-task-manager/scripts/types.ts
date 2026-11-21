export interface Option {
  id?: string;
  name: string;
  color: string;
  description: string;
}
export interface Field {
  id: string;
  name: string;
  dataType: string;
  options?: Option[];
}
export interface Connection<T> {
  nodes: T[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
}
export interface View {
  id: string;
  name: string;
  layout: string;
  filter: string | null;
  sortByFields: Connection<{ direction: string; field: { name: string } }>;
  verticalGroupByFields: Connection<{ name: string }>;
  fields: Connection<{ name: string }>;
}
export interface Project {
  id: string;
  number: number;
  title: string;
  closed: boolean;
  public: boolean;
  url: string;
  owner: { login: string };
  fields: Connection<Field>;
  views: Connection<View>;
  workflows: Connection<{ id: string; name: string; enabled: boolean }>;
}
export interface Repo {
  full_name: string;
  name: string;
  node_id: string;
  private: boolean;
  default_branch: string;
  owner: { login: string; type: string; node_id: string };
}
export interface Issue {
  number: number;
  node_id: string;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  milestone: { number: number; title: string } | null;
  pull_request?: unknown;
}
export interface Item {
  id: string;
  status: { name: string } | null;
  fieldValues: Connection<{ name?: string; number?: number; field: { name: string } }>;
  content: {
    __typename: string;
    number?: number;
    url?: string;
    title?: string;
    body?: string;
    state?: string;
    createdAt?: string;
    repository?: { nameWithOwner: string };
    labels?: Connection<{ name: string }>;
    assignees?: Connection<{ login: string }> & { totalCount: number };
    deps?: { blockedBy: number; blocking: number };
  } | null;
}
export interface Api {
  rest<T>(method: string, path: string, body?: unknown): Promise<T>;
  pages<T>(path: string): Promise<T[]>;
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}
export interface Context {
  api: Api;
  repo: Repo;
  plan: boolean;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<unknown>;
}
