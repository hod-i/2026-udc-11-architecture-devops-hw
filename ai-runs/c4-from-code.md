- Інструмент і модель: Claude Code (термінал), Claude Opus 5.5
- Дата: 2026-10-30
- Що бачила сесія: тимчасова тека `../ws11-b-code/` — уся `app/`
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
● I'll start by looking at the project structure.

  Ran 1 shell command (ctrl+o to expand)

● Small codebase — I'll read all the sources and docs.

  Read 13 files (ctrl+o to expand)

● C4-діаграми «Поштомата громади»

  Діаграми побудовані за кодом у app/, а не тільки за ARCHITECTURE.md
  (app/docs/ARCHITECTURE.md). У кількох місцях документ розходиться з кодом,
  тому де вони не збігаються, я брав версію з коду. Розбіжності перелічені в
  кінці.

  Рівень 1 — System Context

  mermaid
  C4Context
    title System Context — Поштомат громади

    Person(resident, "Мешканець", "Отримує SMS з кодом і забирає посилку з
  поштомата")
    Person(courierPerson, "Кур'єр служби доставки", "Кладе посилку в комірку і
  сканує її")
    Person(staff, "Персонал громади", "Переглядає список посилок, ролі staff або
  admin")

    System(poshtomat, "Поштомат громади", "Реєструє посилки, генерує 6-значні
  коди отримання, шле SMS, повертає незабрані посилки")

    System_Ext(scanner, "Сканер служби доставки", "Пристрій або ПЗ кур'єра")
    System_Ext(locker, "Термінал поштомата", "Екран, на якому мешканець вводить
  код")
    System_Ext(smsProvider, "SMS-провайдер", "HTTP API для надсилання SMS")
    System_Ext(courierApi, "API повернень кур'єрської компанії", "Приймає заявки
  на повернення відправнику")
    System_Ext(monitoring, "Моніторинг", "Періодично перевіряє доступність")

    Rel(courierPerson, scanner, "Сканує посилку")
    Rel(scanner, poshtomat, "Реєструє посилку", "JSON/HTTP")
    Rel(resident, locker, "Вводить код")
    Rel(locker, poshtomat, "Перевіряє код і видає посилку", "JSON/HTTP")
    Rel(staff, poshtomat, "Переглядає посилки, телефони замасковані",
  "JSON/HTTP, Bearer-сесія")
    Rel(monitoring, poshtomat, "Health-check", "HTTP")
    Rel(poshtomat, smsProvider, "Надсилає SMS про прибуття", "JSON/HTTP,
  Bearer-токен")
    Rel(smsProvider, resident, "SMS з номером поштомата і кодом", "SMS")
    Rel(poshtomat, courierApi, "Заявка на повернення після 72 год", "JSON/HTTP")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")

  Рівень 2 — Container

  mermaid
  C4Container
    title Container — Поштомат громади

    Person(resident, "Мешканець", "Отримує SMS і забирає посилку")
    Person(staff, "Персонал громади", "staff або admin")

    System_Ext(scanner, "Сканер служби доставки", "Реєструє посилку при
  закладанні")
    System_Ext(locker, "Термінал поштомата", "Екран введення коду")
    System_Ext(monitoring, "Моніторинг", "Health-check")

    System_Boundary(poshtomat, "Поштомат громади — одна VM") {
      Container(api, "API", "Node.js 22, node:http, Docker-сервіс api", "POST
  /parcels, POST /pickup, GET /admin/parcels, GET /health. Порт 8080, пул БД до
  4 з'єднань, очікування 2 с, далі 503")
      Container(worker, "SMS-worker", "Node.js 22, Docker-сервіс worker, той
  самий образ", "Кожні 10 с бере до 50 посилок без сповіщення, шле SMS до 5 на
  секунду, на 429 робить до 4 спроб, ставить notifiedAt")
      Container(expire, "Нічна задача expire-parcels", "Node.js 22, cron на VM",
  "Посилки у статусі waiting понад 72 год переводить у returned і замовляє
  повернення")
      ContainerDb(db, "PostgreSQL", "PostgreSQL на хості VM, поза Docker",
  "Таблиці: посилки, події, сесії персоналу")
    }

    System_Ext(smsProvider, "SMS-провайдер", "POST /messages")
    System_Ext(courierApi, "API повернень кур'єрської компанії", "POST
  /returns")

    Rel(scanner, api, "POST /parcels", "JSON/HTTP")
    Rel(resident, locker, "Вводить код")
    Rel(locker, api, "POST /pickup", "JSON/HTTP")
    Rel(staff, api, "GET /admin/parcels", "JSON/HTTP, Bearer-сесія")
    Rel(monitoring, api, "GET /health", "HTTP")

    Rel(api, db, "Посилки, коди, події, перевірка сесій", "SQL, пул з'єднань")
    Rel(worker, db, "Читає посилки без сповіщення, оновлює notifiedAt", "SQL")
    Rel(expire, db, "Шукає прострочені, ставить returned", "SQL")

    Rel(worker, smsProvider, "Надсилає SMS", "JSON/HTTP, Bearer SMS_TOKEN")
    Rel(smsProvider, resident, "SMS з кодом", "SMS")
    Rel(expire, courierApi, "Заявка на повернення", "JSON/HTTP, без
  автентифікації")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")

  Припущення

  1. Термінал поштомата і сканер доставки — зовнішні системи. Їхнього коду в
     репозиторії немає. На діаграмах вони звертаються до API напряму по HTTP.
     Проксі, шлюзу чи TLS-термінатора в коді немає, тому я їх не малював.
  2. Персонал звертається до API напряму. Адмінського інтерфейсу в репозиторії
     немає. Ендпоінта для входу теж немає: сесії тільки перевіряються в БД. Я
     припускаю, що вони створюються десь поза системою, наприклад вручну в БД.
  3. Кур'єрська компанія показана окремо від служби доставки, бо в коді це різні
     інтеграції. Цілком можливо, що це та сама організація.
  4. Нічна задача запускається cron на VM. Так написано в коментарі в
     expire-parcels.js (app/bin/expire-parcels.js#L2). Я вважаю, що вона працює
     з того самого образу і бере ті самі змінні оточення. Як саме її запускають
     (docker compose run чи node на хості), з репозиторію не видно.
  5. PostgreSQL винесено як окремий контейнер даних, хоча працює на хості VM.
     Так сказано в ARCHITECTURE.md. Адаптера до PostgreSQL у репозиторії немає:
     db.js (app/src/db.js) зберігає дані в пам'яті, а DATABASE_URL хоч і
     читається в config.js (app/src/config.js#L7), ніде не використовується.
  6. Моніторинг — зовнішня система, про яку відомо тільки те, що вона опитує
     /health. Логи йдуть у stdout у форматі JSON lines. Чи збирає їх щось далі,
     невідомо, тому збирача логів на діаграмах немає.
  7. Зв'язки й протоколи взяті з коду. Те, що SMS-провайдер працює через HTTPS,
     — моє припущення: за замовчуванням адреса http://localhost:9001.

  Розбіжності між кодом і ARCHITECTURE.md

  - Інтервал worker. У документі 30 с. У коді POLL_INTERVAL_MS = 10_000, а якщо
    батч із 50 посилок заповнений, наступне коло починається одразу
    (worker.js:8-9 (app/src/worker.js#L8-L9)).
  - Довжина коду. У документі він 4-значний, у коді 6-значний (parcels.js:27
    (app/src/parcels.js#L27), parcels.js:60 (app/src/parcels.js#L60)).
  - API повернень кур'єрської компанії. У документі цієї зовнішньої системи
    немає, хоча нічна задача його викликає (courier.js (app/src/courier.js)).
  - Версія. Документ описує v1.5, у package.json стоїть 1.7.3.
  - Каталог deploy/. Документ на нього посилається, але в робочій директорії
    його немає, тож розгортання через docker compose я з файлів не перевірив.
```
