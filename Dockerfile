FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .

CMD ["bash", "-lc", "mkdir -p /app/docker-logs && (npm run test:parallel:headless 2>&1 | tee /app/docker-logs/test-output.log) || true; cp -r /app/test-results /app/docker-logs/ || true"]
