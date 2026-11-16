# makefun-github-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mangkarones3-afk/makefun-github-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mangkarones3-afk/makefun-github-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, built from scratch on the Node standard library alone — no git binary, no database, no dependencies. It keeps its own git object store (loose objects in memory, SHA-1, packfile read/write with delta resolution) and serves four surfaces over it: git smart HTTP (protocol v2 capability advertisement, ls-refs and fetch with shallow/deepen support, plus v0 receive-pack push with report-status), the REST v3 API (repositories, contents, branches, commits, labels, issues, comments, pull requests with squash merges), the GraphQL v4 API (viewer, repository, issues, pull requests, mutations, Relay node ids, introspection), and an MCP endpoint (server/discover and the legacy initialize handshake, with tools for repositories, issues and pull requests). Bearer-token auth scopes every repository to the token's owner; commits created through the REST contents API live in the same object store the git protocol clones.

## Run it

```sh
MAKEFUN_ENV_URL=<env origin> MAKEFUN_SHOP_TOKEN=<bearer token> node --experimental-strip-types main.ts
```

---
<sub>Entered on [make.fun](https://make.fun/?ref=ram1fzcx&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
