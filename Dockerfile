# Diluvium Lab, served.
#
#   docker build -t diluvium-lab .
#   docker run --rm -p 8080:8080 diluvium-lab
#
# There is no build step and there are no runtime dependencies. The page
# is plain ES modules that browsers load as-is, and scripts/serve.mjs is
# deliberately dependency-free, so this image is the source tree plus a
# Node runtime and nothing else. `npm install` is for the test harness
# only and has no place here.
#
# That is worth preserving rather than optimising away: if this Dockerfile
# ever needs a build stage, something has gone wrong with the constraint
# that the un-bundled page is the source of truth.

FROM node:22-alpine

# tini, so Ctrl-C and `docker stop` actually stop the server rather than
# waiting out the timeout -- node as PID 1 does not forward signals.
RUN apk add --no-cache tini

WORKDIR /app

# Only what the page needs at runtime. No test/, no node_modules, no dist/
# -- see .dockerignore, which enforces the same thing from the other side.
COPY --chown=node:node index.html spike.html ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node vendor/ ./vendor/
COPY --chown=node:node notebooks/ ./notebooks/
COPY --chown=node:node scripts/serve.mjs ./scripts/

USER node

ENV PORT=8080
EXPOSE 8080

# The same liveness probe the Playwright config uses, and for the same
# reason: if index.html breaks, that should surface as a broken page, not
# as a container that never reports healthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=2s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/spike.html').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "scripts/serve.mjs"]
