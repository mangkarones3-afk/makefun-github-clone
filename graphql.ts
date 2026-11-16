// The GraphQL v4 surface: a small hand-written parser and executor covering exactly the
// documents gh and github-mcp-server send — viewer, repository reads, issue and
// pull-request connections with cursor pagination, the create/close/merge/comment
// mutations, Relay node ids, batched operations, and the __type introspection probes.
// It runs over the same store as REST, so an object made on one surface reads back on
// the other with the same ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord, parseJsonBody, sendJson } from './http.ts';
import { VIEWER, forge, isoFromCounter, mergeTrees, pullRequestFiles, type IssueState, type RepoState } from './store.ts';
import { createIssueRecord, mergePullRequest } from './rest.ts';

// ------------------------------------------------------------------ node ids

export function encodeNodeId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeNodeId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoNodeId(repo: RepoState): string {
  return encodeNodeId('Repository', repo.id);
}

function issueNodeId(repo: RepoState, issue: IssueState): string {
  return encodeNodeId(issue.isPull ? 'PullRequest' : 'Issue', repo.id, issue.number);
}

// ------------------------------------------------------------------ schema tables

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'url', 'createdAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url', 'primaryLanguage',
  ],
  Ref: ['name', 'prefix', 'repository'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'repository', 'createdAt',
    'updatedAt', 'closed', 'comments', 'labels', 'url', 'viewerCanReact',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'commits',
    'url', 'mergeCommit', 'isDraft',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'CHANGED'],
};

// ------------------------------------------------------------------ parser

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int' | 'float' | 'string' | 'enum'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'list'; readonly items: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyArray<readonly [string, ValueNode]> };

interface FieldNode {
  readonly kind: 'field';
  readonly alias?: string;
  readonly name: string;
  readonly args: ReadonlyMap<string, ValueNode>;
  readonly selection?: readonly SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { readonly kind: 'inline'; readonly typeCondition: string; readonly selection: readonly SelectionNode[] }
  | { readonly kind: 'spread'; readonly name: string };

interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name?: string;
  readonly selection: readonly SelectionNode[];
}

interface DocumentNode {
  readonly operations: readonly OperationNode[];
  readonly fragments: ReadonlyMap<string, readonly SelectionNode[]>;
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntaxError('unterminated block string');
        tokens.push(JSON.stringify(source.slice(i + 3, end)));
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlSyntaxError('unterminated string');
      tokens.push(JSON.stringify(value));
      i = j + 1;
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
    if (nameMatch) {
      tokens.push(nameMatch[0]);
      i += nameMatch[0].length;
      continue;
    }
    const numberMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
    if (numberMatch) {
      tokens.push(numberMatch[0]);
      i += numberMatch[0].length;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlSyntaxError(`expected ${token}, got ${got}`);
  }

  private skipBalanced(): void {
    // Skip a parenthesized group (variable definitions, directives we do not model).
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      else if (token === ')' || token === ']' || token === '}') depth -= 1;
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, readonly SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        let name: string | undefined;
        const maybeName = this.peek();
        if (maybeName !== undefined && /^[_A-Za-z]/.test(maybeName) && maybeName !== 'on') {
          name = this.next();
        }
        if (this.peek() === '(') this.skipBalanced();
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipBalanced();
        }
        operations.push({ type: token === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        this.next(); // type condition
        if (this.peek() === '(') this.skipBalanced();
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new GqlSyntaxError(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): readonly SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new GqlSyntaxError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      return { kind: 'spread', name: this.next() };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = new Map<string, ValueNode>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipBalanced();
    }
    let selection: readonly SelectionNode[] | undefined;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<[string, ValueNode]> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push([name, this.parseValue()]);
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: token };
    if (/^-?\d*\.\d/.test(token)) return { kind: 'float', value: token };
    return { kind: 'enum', value: token };
  }
}

// ------------------------------------------------------------------ execution

type GValue =
  | { readonly t: 'Viewer' }
  | { readonly t: 'Repository'; readonly repo: RepoState }
  | { readonly t: 'Issue'; readonly repo: RepoState; readonly issue: IssueState }
  | { readonly t: 'PullRequest'; readonly repo: RepoState; readonly issue: IssueState }
  | { readonly t: 'Ref'; readonly name: string }
  | { readonly t: 'IssueConnection'; readonly nodes: GValue[]; readonly pageInfo: GValue; readonly totalCount: number }
  | { readonly t: 'PullRequestConnection'; readonly nodes: GValue[]; readonly pageInfo: GValue; readonly totalCount: number }
  | { readonly t: 'FilesConnection'; readonly nodes: GValue[] }
  | { readonly t: 'ChangedFile'; readonly file: { filename: string; additions: number; deletions: number; status: string } }
  | { readonly t: 'PageInfo'; readonly hasNextPage: boolean; readonly endCursor: string | null }
  | { readonly t: 'Comment'; readonly repo: RepoState; readonly issue: IssueState; readonly comment: { id: number; body: string } }
  | { readonly t: 'CommentConnection'; readonly nodes: GValue[] }
  | { readonly t: 'Payload'; readonly kind: string; readonly repo?: RepoState; readonly issue?: IssueState; readonly comment?: { id: number; body: string } }
  | { readonly t: 'CommentEdge'; readonly repo: RepoState; readonly issue: IssueState; readonly comment: { id: number; body: string } }
  | { readonly t: '__Type'; readonly name: string }
  | { readonly t: '__Field'; readonly name: string }
  | { readonly t: '__EnumValue'; readonly name: string }
  | { readonly t: 'Scalar'; readonly value: unknown };

interface ExecContext {
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: ReadonlyMap<string, readonly SelectionNode[]>;
  readonly errors: Array<{ message: string }>;
}

function typeNameOf(value: GValue): string {
  switch (value.t) {
    case 'Viewer': return 'User';
    case 'FilesConnection': return 'PullRequestChangedFileConnection';
    case 'CommentConnection': return 'IssueCommentConnection';
    case 'Comment': return 'IssueComment';
    case 'CommentEdge': return 'IssueCommentEdge';
    case 'Payload':
      return {
        createIssue: 'CreateIssuePayload',
        closeIssue: 'CloseIssuePayload',
        createPullRequest: 'CreatePullRequestPayload',
        mergePullRequest: 'MergePullRequestPayload',
        addComment: 'AddCommentPayload',
      }[value.kind] ?? 'Payload';
    default: return value.t;
  }
}

function resolveValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'variable': return ctx.variables[node.name] ?? null;
    case 'int': return Number.parseInt(node.value, 10);
    case 'float': return Number.parseFloat(node.value);
    case 'string': return node.value;
    case 'enum': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'list': return node.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = resolveValue(value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, ctx);
  return out;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  return match ? Number.parseInt(match[1], 10) : null;
}

function findRepoByNodeId(id: unknown): RepoState | null {
  const decoded = typeof id === 'string' ? decodeNodeId(id) : null;
  if (!decoded || decoded.kind !== 'Repository') return null;
  const repoId = Number.parseInt(decoded.parts[0], 10);
  for (const repo of forge.repos.values()) if (repo.id === repoId) return repo;
  return null;
}

function findIssueByNodeId(id: unknown): { repo: RepoState; issue: IssueState } | null {
  const decoded = typeof id === 'string' ? decodeNodeId(id) : null;
  if (!decoded || (decoded.kind !== 'Issue' && decoded.kind !== 'PullRequest')) return null;
  const repoId = Number.parseInt(decoded.parts[0], 10);
  const number = Number.parseInt(decoded.parts[1], 10);
  for (const repo of forge.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.get(number);
    if (issue) return { repo, issue };
  }
  return null;
}

function issuesConnection(repo: RepoState, args: Record<string, unknown>): GValue {
  let list = [...repo.issues.values()].filter((issue) => !issue.isPull);
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
  if (states && states.length > 0) {
    list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const totalCount = list.length;
  let start = 0;
  const afterNumber = cursorNumber(args.after);
  if (afterNumber !== null) {
    const index = list.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < totalCount;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return {
    t: 'IssueConnection',
    nodes: page.map((issue) => ({ t: 'Issue', repo, issue }) as GValue),
    pageInfo: { t: 'PageInfo', hasNextPage, endCursor },
    totalCount,
  };
}

function pullRequestsConnection(repo: RepoState, args: Record<string, unknown>): GValue {
  let list = [...repo.issues.values()].filter((issue) => issue.isPull);
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
  if (states && states.length > 0) {
    list = list.filter((issue) => {
      const state = issue.merged ? 'MERGED' : issue.state === 'open' ? 'OPEN' : 'CLOSED';
      return states.includes(state);
    });
  } else {
    list = list.filter((issue) => issue.state === 'open');
  }
  list.sort((a, b) => b.number - a.number);
  const totalCount = list.length;
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
  const page = list.slice(0, first);
  return {
    t: 'PullRequestConnection',
    nodes: page.map((issue) => ({ t: 'PullRequest', repo, issue }) as GValue),
    pageInfo: { t: 'PageInfo', hasNextPage: page.length < totalCount, endCursor: null },
    totalCount,
  };
}

function pullRequestMergeable(repo: RepoState, pull: IssueState): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const outcome = mergeTrees(repo, pull.baseRef, pull.headRef);
  if (outcome.ok) return 'MERGEABLE';
  return outcome.conflictPath ? 'CONFLICTING' : 'UNKNOWN';
}

function resolveRootField(type: 'Query' | 'Mutation', field: FieldNode, ctx: ExecContext): GValue | null {
  const args = argsOf(field, ctx);
  if (type === 'Query') {
    switch (field.name) {
      case 'viewer':
        return { t: 'Viewer' };
      case 'repository': {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = forge.getRepo(owner, name);
        return repo ? { t: 'Repository', repo } : null;
      }
      case 'node': {
        const decoded = typeof args.id === 'string' ? decodeNodeId(args.id) : null;
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = findRepoByNodeId(args.id);
          return repo ? { t: 'Repository', repo } : null;
        }
        if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
          const found = findIssueByNodeId(args.id);
          if (!found) return null;
          return found.issue.isPull
            ? { t: 'PullRequest', repo: found.repo, issue: found.issue }
            : { t: 'Issue', repo: found.repo, issue: found.issue };
        }
        if (decoded.kind === 'User') return { t: 'Viewer' };
        return null;
      }
      case '__type': {
        const name = typeof args.name === 'string' ? args.name : '';
        if (TYPE_FIELDS[name] || ENUM_VALUES[name]) return { t: '__Type', name };
        return null;
      }
      case '__schema':
        return null;
      default:
        break;
    }
  } else {
    const input = isRecord(args.input) ? args.input : {};
    switch (field.name) {
      case 'createIssue': {
        const repo = findRepoByNodeId(input.repositoryId);
        if (!repo) {
          ctx.errors.push({ message: 'Repository not found' });
          return null;
        }
        const issue = createIssueRecord(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
        });
        return { t: 'Payload', kind: 'createIssue', repo, issue };
      }
      case 'closeIssue': {
        const found = findIssueByNodeId(input.issueId);
        if (!found) {
          ctx.errors.push({ message: 'Issue not found' });
          return null;
        }
        found.issue.state = 'closed';
        return { t: 'Payload', kind: 'closeIssue', repo: found.repo, issue: found.issue };
      }
      case 'createPullRequest': {
        const repo = findRepoByNodeId(input.repositoryId);
        const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
        const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        if (!repo || !repo.refs.has(`refs/heads/${headRefName}`) || !repo.refs.has(`refs/heads/${baseRefName}`)) {
          ctx.errors.push({ message: 'Head or base branch does not exist' });
          return null;
        }
        const pull = createIssueRecord(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          isPull: true,
          headRef: headRefName,
          baseRef: baseRefName,
        });
        return { t: 'Payload', kind: 'createPullRequest', repo, issue: pull };
      }
      case 'mergePullRequest': {
        const found = findIssueByNodeId(input.pullRequestId);
        if (!found || !found.issue.isPull) {
          ctx.errors.push({ message: 'Pull request not found' });
          return null;
        }
        const methodName = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
        const method = methodName === 'MERGE' ? 'merge' : methodName === 'REBASE' ? 'rebase' : 'squash';
        const outcome = mergePullRequest(found.repo, found.issue, method);
        if (!outcome.ok) {
          ctx.errors.push({ message: outcome.reason === 'conflict' ? 'Merge conflict' : 'Pull request is not mergeable' });
          return null;
        }
        return { t: 'Payload', kind: 'mergePullRequest', repo: found.repo, issue: found.issue };
      }
      case 'addComment': {
        const found = findIssueByNodeId(input.subjectId);
        if (!found) {
          ctx.errors.push({ message: 'Subject not found' });
          return null;
        }
        const comment = { id: found.repo.nextCommentId++, body: typeof input.body === 'string' ? input.body : '' };
        found.issue.comments.push(comment);
        return { t: 'Payload', kind: 'addComment', repo: found.repo, issue: found.issue, comment };
      }
      default:
        break;
    }
  }
  ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'` });
  return null;
}

function resolveField(value: GValue, field: FieldNode, ctx: ExecContext): unknown {
  const args = argsOf(field, ctx);
  const name = field.name;
  if (name === '__typename') return typeNameOf(value);
  switch (value.t) {
    case 'Viewer':
      switch (name) {
        case 'login': return VIEWER.login;
        case 'id': return encodeNodeId('User', VIEWER.id);
        case 'name': return VIEWER.name;
        case 'email': return VIEWER.email;
        default: break;
      }
      break;
    case 'Repository': {
      const repo = value.repo;
      switch (name) {
        case 'id': return repoNodeId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'owner': return { t: 'Viewer' } as GValue;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip ? ({ t: 'Ref', name: repo.defaultBranch } as GValue) : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const issue = repo.issues.get(number);
          return issue && !issue.isPull ? ({ t: 'Issue', repo, issue } as GValue) : null;
        }
        case 'issues': return issuesConnection(repo, args);
        case 'pullRequest': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const pull = repo.issues.get(number);
          return pull && pull.isPull ? ({ t: 'PullRequest', repo, issue: pull } as GValue) : null;
        }
        case 'pullRequests': return pullRequestsConnection(repo, args);
        case 'createdAt': return isoFromCounter(repo.id);
        case 'updatedAt': return isoFromCounter(repo.id);
        default: break;
      }
      break;
    }
    case 'Ref':
      if (name === 'name') return value.name;
      if (name === 'prefix') return 'refs/heads/';
      break;
    case 'Issue': {
      const { repo, issue } = value;
      switch (name) {
        case 'id': return issueNodeId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
        case 'author': return { t: 'Viewer' } as GValue;
        case 'repository': return { t: 'Repository', repo } as GValue;
        case 'createdAt': return isoFromCounter(issue.number);
        case 'updatedAt': return isoFromCounter(issue.number);
        case 'closed': return issue.state === 'closed';
        case 'comments':
          return {
            t: 'CommentConnection',
            nodes: issue.comments.map((comment) => ({ t: 'Comment', repo, issue, comment }) as GValue),
          } as GValue;
        case 'url': return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
        default: break;
      }
      break;
    }
    case 'PullRequest': {
      const { repo, issue } = value;
      switch (name) {
        case 'id': return issueNodeId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.merged ? 'MERGED' : issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return issue.merged;
        case 'mergeable': return pullRequestMergeable(repo, issue);
        case 'headRefName': return issue.headRef;
        case 'baseRefName': return issue.baseRef;
        case 'author': return { t: 'Viewer' } as GValue;
        case 'repository': return { t: 'Repository', repo } as GValue;
        case 'files': {
          const files = pullRequestFiles(repo, issue.baseRef, issue.headRef);
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : files.length;
          return {
            t: 'FilesConnection',
            nodes: files.slice(0, first).map((file) => ({ t: 'ChangedFile', file }) as GValue),
          } as GValue;
        }
        case 'createdAt': return isoFromCounter(issue.number);
        case 'updatedAt': return isoFromCounter(issue.number);
        case 'isDraft': return false;
        case 'url': return `/${repo.owner}/${repo.name}/pull/${issue.number}`;
        default: break;
      }
      break;
    }
    case 'IssueConnection':
      if (name === 'nodes') return value.nodes;
      if (name === 'pageInfo') return value.pageInfo;
      if (name === 'totalCount') return value.totalCount;
      if (name === 'edges') return value.nodes.map((node) => ({ t: 'Scalar', value: { node } }));
      break;
    case 'PullRequestConnection':
      if (name === 'nodes') return value.nodes;
      if (name === 'pageInfo') return value.pageInfo;
      if (name === 'totalCount') return value.totalCount;
      break;
    case 'FilesConnection':
      if (name === 'nodes') return value.nodes;
      if (name === 'pageInfo') return { t: 'PageInfo', hasNextPage: false, endCursor: null } as GValue;
      if (name === 'totalCount') return value.nodes.length;
      break;
    case 'ChangedFile':
      if (name === 'path') return value.file.filename;
      if (name === 'additions') return value.file.additions;
      if (name === 'deletions') return value.file.deletions;
      if (name === 'changeType') return value.file.status === 'added' ? 'ADDED' : value.file.status === 'removed' ? 'DELETED' : 'MODIFIED';
      break;
    case 'PageInfo':
      if (name === 'hasNextPage') return value.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'endCursor') return value.endCursor;
      if (name === 'startCursor') return value.endCursor;
      break;
    case 'Comment':
      if (name === 'id') return encodeNodeId('IssueComment', value.repo.id, value.comment.id);
      if (name === 'body') return value.comment.body;
      if (name === 'author') return { t: 'Viewer' } as GValue;
      if (name === 'createdAt') return isoFromCounter(value.comment.id);
      break;
    case 'CommentConnection':
      if (name === 'nodes') return value.nodes;
      if (name === 'totalCount') return value.nodes.length;
      if (name === 'pageInfo') return { t: 'PageInfo', hasNextPage: false, endCursor: null } as GValue;
      break;
    case 'Payload': {
      if (name === 'clientMutationId') return null;
      if (name === 'issue' && value.issue) return { t: 'Issue', repo: value.repo!, issue: value.issue } as GValue;
      if (name === 'pullRequest' && value.issue) return { t: 'PullRequest', repo: value.repo!, issue: value.issue } as GValue;
      if (name === 'commentEdge' && value.comment && value.issue) {
        return { t: 'CommentEdge', repo: value.repo!, issue: value.issue, comment: value.comment } as GValue;
      }
      if (name === 'subject' && value.issue) {
        return value.issue.isPull
          ? ({ t: 'PullRequest', repo: value.repo!, issue: value.issue } as GValue)
          : ({ t: 'Issue', repo: value.repo!, issue: value.issue } as GValue);
      }
      break;
    }
    case 'CommentEdge':
      if (name === 'node') return { t: 'Comment', repo: value.repo, issue: value.issue, comment: value.comment } as GValue;
      if (name === 'cursor') return cursorFor(value.comment.id);
      break;
    case '__Type': {
      if (name === 'name') return value.name;
      if (name === 'kind') return ENUM_VALUES[value.name] ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const fields = TYPE_FIELDS[value.name];
        return fields ? fields.map((fieldName) => ({ t: '__Field', name: fieldName }) as GValue) : null;
      }
      if (name === 'enumValues') {
        const values = ENUM_VALUES[value.name];
        return values ? values.map((enumName) => ({ t: '__EnumValue', name: enumName }) as GValue) : null;
      }
      if (name === 'description') return null;
      if (name === 'possibleTypes') return null;
      if (name === 'inputFields') return null;
      if (name === 'ofType') return null;
      break;
    }
    case '__Field':
      if (name === 'name') return value.name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'args') return [];
      break;
    case '__EnumValue':
      if (name === 'name') return value.name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      break;
    case 'Scalar':
      return value.value;
  }
  ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${typeNameOf(value)}'` });
  return null;
}

/** Apply a selection set to a value, producing the JSON the wire carries. */
function applySelection(value: unknown, selection: readonly SelectionNode[] | undefined, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => applySelection(item, selection, ctx));
  if (typeof value !== 'object') return value;
  const gvalue = value as GValue;
  if (gvalue.t === 'Scalar') return gvalue.value;
  if (!selection) return null;
  const out: Record<string, unknown> = {};
  const walk = (selections: readonly SelectionNode[]): void => {
    for (const node of selections) {
      if (node.kind === 'spread') {
        const fragment = ctx.fragments.get(node.name);
        if (fragment) walk(fragment);
        continue;
      }
      if (node.kind === 'inline') {
        if (node.typeCondition === typeNameOf(gvalue) || node.typeCondition === 'Node' || node.typeCondition === 'Repository') {
          walk(node.selection);
        }
        continue;
      }
      const key = node.alias ?? node.name;
      if (node.name === '__typename') {
        out[key] = typeNameOf(gvalue);
        continue;
      }
      const resolved = resolveField(gvalue, node, ctx);
      out[key] = applySelection(resolved, node.selection, ctx);
    }
  };
  walk(selection);
  return out;
}

function executeOperation(operation: OperationNode, doc: DocumentNode, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecContext = { variables, fragments: doc.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  const walkRoot = (selections: readonly SelectionNode[]): void => {
    for (const node of selections) {
      if (node.kind !== 'field') continue;
      const key = node.alias ?? node.name;
      if (node.name === '__typename') {
        data[key] = rootType;
        continue;
      }
      const resolved = resolveRootField(rootType, node, ctx);
      data[key] = applySelection(resolved, node.selection, ctx);
    }
  };
  walkRoot(operation.selection);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

function executeDocument(source: string, variables: Record<string, unknown>, operationName?: string): Record<string, unknown> {
  let doc: DocumentNode;
  try {
    doc = new Parser(tokenize(source)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const operation =
    doc.operations.find((op) => operationName !== undefined && op.name === operationName) ?? doc.operations[0];
  if (!operation) return { errors: [{ message: 'No operation found' }] };
  return executeOperation(operation, doc, variables);
}

// ------------------------------------------------------------------ HTTP

export async function handleGraphql(_req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed.value)) {
    const results = parsed.value.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { errors: [{ message: 'Invalid operation' }] };
      }
      return executeDocument(
        entry.query,
        isRecord(entry.variables) ? entry.variables : {},
        typeof entry.operationName === 'string' ? entry.operationName : undefined,
      );
    });
    sendJson(res, 200, results);
    return;
  }
  if (!isRecord(parsed.value) || typeof parsed.value.query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'A query is required' }] });
    return;
  }
  const result = executeDocument(
    parsed.value.query,
    isRecord(parsed.value.variables) ? parsed.value.variables : {},
    typeof parsed.value.operationName === 'string' ? parsed.value.operationName : undefined,
  );
  sendJson(res, 200, result);
}
