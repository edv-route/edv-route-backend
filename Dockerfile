# Multi-stage build for the Fastify API.
# Stage 1 compiles TypeScript; the runtime image ships only prod deps + dist.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Railway injects PORT; the server reads HOST (0.0.0.0) and PORT from the env.
CMD ["node", "dist/server.js"]
