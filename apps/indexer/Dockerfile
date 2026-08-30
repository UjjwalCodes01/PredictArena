# The indexer is a daemon, not a request handler. It needs a host that keeps a
# process alive — Railway, Fly, Render, or any VPS. This image runs on all of
# them without modification.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Workspace manifests first, so a dependency install is cached independently of
# source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json packages/db/
COPY packages/dex/package.json packages/dex/
COPY apps/indexer/package.json apps/indexer/

# --frozen-lockfile: the deploy must fail loudly on a lockfile drift rather than
# quietly resolving different versions than CI tested.
RUN pnpm install --frozen-lockfile --filter @predictarena/indexer...

COPY packages/ packages/
COPY apps/indexer/ apps/indexer/

ENV NODE_ENV=production

# Exec form, so the process is PID 1 and receives SIGTERM directly. Through a
# shell or a package-manager wrapper the signal reaches the wrapper instead and
# the worker is orphaned — which cost us four minutes of a corrupted measurement
# during Phase 2.
WORKDIR /repo/apps/indexer
CMD ["node", "--import", "tsx", "src/main.ts"]
