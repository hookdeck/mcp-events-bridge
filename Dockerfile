# The bridge: one Node process serving the inbound routes and the MCP endpoint.
# Stateless (Event Gateway is the store), so no volume.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json bridge.config.ts ./
COPY src ./src
EXPOSE 8080
CMD ["npx", "tsx", "src/cli.ts", "serve"]
