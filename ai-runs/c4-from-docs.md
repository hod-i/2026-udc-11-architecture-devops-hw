- Інструмент і модель: Claude Code (термінал), Claude Opus 5.5
- Дата: 2026-10-30
- Що бачила сесія: тимчасова тека `../ws11-b-docs/` — лише `app/README.md` і `app/docs/ARCHITECTURE.md`
- Пам'ять і глобальні інструкції: auto memory вимкнено; глобального `~/.claude/CLAUDE.md`
  немає; на рівні користувача встановлено скіли openspec — у прогоні не викликались
- Як збережено: відповідь скопійовано з термінала як є (переноси рядків — від термінала;
  блоки Mermaid термінал показує без огорож). Агент не ставив уточнювальних питань.
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

```text
● Спершу подивлюся, що є в робочій директорії.

  Read 2 files, ran 1 shell command (ctrl+o to expand)

● C4-архітектура «Поштомата громади»

  Код системи я не бачив. У робочій директорії є лише два файли: app/README.md і
  app/docs/ARCHITECTURE.md. Файлів src/server.js, src/worker.js,
  bin/expire-parcels.js і папки deploy/, на які вони посилаються, тут немає.
  Тому діаграми побудовані за документацією (ARCHITECTURE.md, версія 1.5,
  червень 2026), і перевірити їх за кодом я не зміг.

  Припущення

  1. Показано продакшн-варіант. Сховище — PostgreSQL. Сховище в пам'яті
     (src/db.js) призначене лише для локального запуску, тому на діаграмах його
     немає.
  2. Екран поштомата і сканер служби доставки — зовнішні системи. Це обладнання,
     яке звертається до API, а його код у репозиторії не згадано.
  3. Персонал заходить в адмінку з браузера або іншого HTTP-клієнта прямо до
     API. Окремого фронтенду в документації немає. Таблиця «сесії персоналу»
     вказує на вхід з логіном, але як саме працює автентифікація, не описано.
  4. Моніторинг — зовнішня система, яка опитує GET /health.
  5. Протокол позначено як HTTP, як у документації. Чи є TLS (наприклад, через
     reverse proxy), невідомо.
  6. Нічна задача запускається cron-ом на хості VM (через docker compose run або
     як node-скрипт). У compose є лише сервіси api і worker, тож як саме її
     запускають, з документації не видно.
  7. PostgreSQL входить у межі системи, хоча працює на VM поза контейнерами.

  Рівень 1: System Context

  mermaid
  C4Context
      title System Context — Поштомат громади

      Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку з
  поштомата")
      Person(courier, "Кур'єр служби доставки", "Закладає посилки в поштомат")
      Person(staff, "Персонал громади", "Переглядає список посилок")

      System(parcelSystem, "Поштомат громади", "Реєструє посилки, сповіщає
  мешканців, видає посилки за кодом, повертає прострочені")

      System_Ext(lockerScreen, "Екран поштомата", "Термінал на поштоматі:
  введення коду отримання")
      System_Ext(scanner, "Сканер служби доставки", "Пристрій кур'єра для
  реєстрації посилок")
      System_Ext(sms, "SMS-провайдер", "Зовнішній HTTP API для надсилання SMS")
      System_Ext(monitoring, "Моніторинг", "Перевіряє доступність сервісу")

      Rel(courier, scanner, "Сканує посилку")
      Rel(scanner, parcelSystem, "Реєструє посилку", "HTTP")
      Rel(resident, lockerScreen, "Вводить 4-значний код")
      Rel(lockerScreen, parcelSystem, "Перевіряє код і відкриває комірку",
  "HTTP")
      Rel(staff, parcelSystem, "Переглядає посилки", "HTTP")
      Rel(monitoring, parcelSystem, "Health-check", "HTTP")
      Rel(parcelSystem, sms, "Надсилає SMS з кодом", "HTTP API")
      Rel(sms, resident, "SMS з кодом отримання", "SMS")

      UpdateLayoutConfig($c4ShapeInRow="4", $c4BoundaryInRow="1")

  Рівень 2: Container

  mermaid
  C4Container
      title Container — Поштомат громади

      Person(resident, "Мешканець", "Забирає посилку за кодом")
      Person(courier, "Кур'єр служби доставки", "Закладає посилки")
      Person(staff, "Персонал громади", "Адміністрування")

      System_Ext(lockerScreen, "Екран поштомата", "Термінал на поштоматі")
      System_Ext(scanner, "Сканер служби доставки", "Пристрій кур'єра")
      System_Ext(monitoring, "Моніторинг", "Опитує health-check")
      System_Ext(sms, "SMS-провайдер", "HTTP API для SMS")

      System_Boundary(vm, "Поштомат громади (одна VM)") {
          Container(api, "API", "Node.js 22, HTTP, Docker-сервіс api", "POST
  /parcels, POST /pickup, GET /admin/parcels, GET /health")
          Container(worker, "Worker", "Node.js 22, Docker-сервіс worker (той
  самий образ)", "Кожні 30 с бере посилки без сповіщення і шле SMS з кодом")
          Container(expire, "Нічна задача expire-parcels", "Node.js скрипт,
  запуск за розкладом", "Позначає посилки старші за 72 год як повернені")
          ContainerDb(db, "PostgreSQL", "PostgreSQL на хості VM, поза
  контейнерами", "Таблиці: посилки, події, сесії персоналу")
      }

      Rel(courier, scanner, "Сканує посилку")
      Rel(scanner, api, "POST /parcels", "HTTP")
      Rel(resident, lockerScreen, "Вводить код")
      Rel(lockerScreen, api, "POST /pickup", "HTTP")
      Rel(staff, api, "GET /admin/parcels", "HTTP")
      Rel(monitoring, api, "GET /health", "HTTP")

      Rel(api, db, "Створює посилки, перевіряє коди, читає список, сесії",
  "SQL")
      Rel(worker, db, "Читає посилки без сповіщення, позначає сповіщені", "SQL")
      Rel(expire, db, "Позначає прострочені як повернені", "SQL")
      Rel(worker, sms, "Надсилає SMS з кодом", "HTTP API")
      Rel(sms, resident, "SMS з кодом", "SMS")

      UpdateLayoutConfig($c4ShapeInRow="4", $c4BoundaryInRow="1")

  Що варто перевірити, коли буде код

  - Як запускається нічна задача: у описі розгортання вона не згадана (див.
    припущення 6).
  - Чи є між API і worker інший канал, крім спільної БД. У документації worker
    лише опитує БД кожні 30 секунд, черги немає.
  - Як працює автентифікація для /admin/parcels, а також для сканера й екрана
    поштомата.
  - Чи актуальний ARCHITECTURE.md. Він датований червнем 2026, а звірити його з
    кодом я не мав змоги.
```
