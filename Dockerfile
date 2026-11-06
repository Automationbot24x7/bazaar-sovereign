# Bazaar Sovereign: one always-on Node server (game state lives in memory).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
EXPOSE 8080
USER node
CMD ["node", "server/index.js"]
