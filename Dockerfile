# Dockerfile for universal-agent-os.
#
# This image is provided as a *secondary* convenience for contributors who
# want a containerized dev environment. It is NOT the recommended path —
# agent-os is a CLI/TUI tool that works best installed locally with the
# host's pnpm and Node toolchain. Native install gives you working TTY,
# native notifications, and direct access to provider CLIs (claude, codex,
# gemini, etc.) which are not present inside this image.
#
# Use cases that justify the container:
#   - Reproducing a CI failure locally on a non-Linux host.
#   - Smoke-testing the build/install flow in a clean environment.
#
# Build:   docker build -t universal-agent-os .
# Run:     docker run --rm -it universal-agent-os
# Dev shell: docker run --rm -it -v "$PWD:/app" universal-agent-os sh

FROM node:22-alpine

# git is needed for the worktree-based workspace flow; bash makes
# interactive debugging less painful than ash.
RUN apk add --no-cache git bash \
    && corepack enable \
    && corepack prepare pnpm@10.33.2 --activate

WORKDIR /app

# Copy manifests first so the install layer caches across source edits.
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

# Copy the rest of the source and build.
COPY . .

RUN pnpm run build

# Default to the CLI entry point. Override with e.g. `sh` for a shell.
CMD ["node", "dist/src/bin/agent-os.js"]
