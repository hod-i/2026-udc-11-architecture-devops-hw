# syntax=docker/dockerfile:1
# Один образ для api, worker і нічної задачі; яку з них запускати, задає compose.yaml.
# Node — LTS-гілка, та сама, що в CI (pipeline/deploy.yml). Для повної відтворюваності
# додай дайджест (node:24-trixie-slim@sha256:...) і оновлюй його через Dependabot.
FROM node:24-trixie-slim

ENV NODE_ENV=production

WORKDIR /app

# Залежностей немає, тож копіюємо лише те, що потрібно під час роботи: package.json (з
# нього читається версія), src/ і bin/. Тести, документація та випадкові .env у образ
# не потрапляють. Файли належать root, тож процес не може їх змінити.
COPY package.json ./
COPY src/ ./src/
COPY bin/ ./bin/

# Користувач node (uid 1000) уже є в офіційному образі.
USER node

EXPOSE 8080
# Перевірка для api (CMD за замовчуванням). У slim-образі немає curl, тож — через node.
# worker і нічна задача HTTP-сервера не мають і вимикають її в compose.yaml.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/server.js"]
