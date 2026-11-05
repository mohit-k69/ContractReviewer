# ClamAV scanning API. ClamAV itself runs in a separate sidecar container (see service.yaml) and is reached on localhost.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]
