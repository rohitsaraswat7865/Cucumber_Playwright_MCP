FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

ENV CI=true

COPY package*.json ./
RUN npm ci

COPY . .

CMD ["bash", "-lc", "set -o pipefail; mkdir -p /app/docker-logs /app/playwright-report /app/test-results; npm run test:parallel:headless 2>&1 | tee /app/docker-logs/test-output.log; test_status=${PIPESTATUS[0]}; exit ${test_status}"]
