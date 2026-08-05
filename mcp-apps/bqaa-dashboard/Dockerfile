FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
# Cloud Run injects PORT; server.ts reads it (defaults to 3001 locally)
CMD ["npx", "tsx", "server.ts"]
