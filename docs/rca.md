# RCA: інцидент 2026-10-14 — поштомати не видають посилки

Усі команди запускаються з кореня репо і працюють однаково в Git Bash, PowerShell і cmd:
запити до логів і метрик — `docs/rca-queries.mjs` (Node 22+, без залежностей; опис команд —
у шапці файлу). Часові межі `[від, до)` — за Europe/Kyiv. Кожне твердження в таблицях нижче
має власну повну команду і її вивід; результати перевірено запуском.

## Коротко

З 14:02 до 14:47 API відповідав `503 service busy` на ~11 % запитів, і мешканці бачили на
екрані поштомата «Сервіс зайнятий» замість видачі посилки. Причина — реліз v1.8.0, який
перейменував у `compose.yaml` змінну `DB_POOL_MAX` на `DB_POOL_SIZE`: застосунок такої змінної
не читає і мовчки взяв пул з'єднань за замовчуванням — 4 замість 20, а на денне навантаження
потрібно 10–13. Відкат на v1.7.3 повернув пул 20, і помилки зникли за секунди.

## Хронологія (Europe/Kyiv)

| Час | Подія | Джерело (файл або команда → результат) |
|---|---|---|
| 13:28 | Перші `429` від SMS-провайдера — як і щодня | `node docs/rca-queries.mjs above incident/metrics/2026-10-14.csv sms_429_per_min 0` → `94 min, first 13:28, last 15:01`; 13.10: `node docs/rca-queries.mjs above incident/baseline/metrics-2026-10-13.csv sms_429_per_min 0` → `95 min, first 13:24, last 15:01` |
| 13:37 | Алерт `SmsProvider429RateHigh` (warning) | `incident/alerts.json:7-12` |
| 13:40 | Чергова бачить 429, SMS доходять — вирішує не втручатися | `incident/oncall-chat.md:6` |
| 14:01:37 | Одна помилка `TLS handshake timeout to sms.example.net` у worker | `node docs/rca-queries.mjs find incident/logs/worker-2026-10-14.jsonl "TLS handshake"` → `count 1`, `14:01:37.954` |
| 14:01:58 | API отримує SIGTERM — початок деплою v1.8.0 «config cleanup» | `incident/deploys.log:7`; `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "shutting down" ts` → `14:01:58.214`, `14:20:29.530`, `14:46:58.401` |
| 14:02:00 | API v1.8.0 стартував; у цю ж хвилину `db_pool_in_use` = 4 (до того 12), з'являється черга | `node docs/rca-queries.mjs rows incident/metrics/2026-10-14.csv 14:00 14:05 rps,p95_ms,error_rate,db_pool_in_use,db_pool_waiting` → `14:01,11.3,245,0.0044,12,0`, `14:02,11.9,945,0.0042,4,4`, `14:03,11,2446,0.0333,4,10` |
| 14:02:07 | Перша `503 db pool wait timeout after 2000ms` | `node docs/rca-queries.mjs find incident/logs/api-2026-10-14.jsonl "db pool wait timeout"` → рядок `first` з `"ts":"2026-10-14T14:02:07.172+03:00"`, `"status":503` |
| 14:06 / 14:07 | Пейджі `ApiLatencyP95High` і `Api5xxRateHigh` | `incident/alerts.json:15-28` |
| 14:08 | Гаряча лінія: «Сервіс зайнятий» на поштоматах | `incident/oncall-chat.md:9` |
| 14:10–14:14 | Чергова підозрює 429 від провайдера, heap 81 % і TLS-тайм-аут; автор релізу: «нічого суттєвого — причесав конфіг» | `incident/oncall-chat.md:10-14` |
| 14:20:31 | Перезапуск лише API, та сама v1.8.0 — не допомагає | `incident/deploys.log:8`; `node docs/rca-queries.mjs per-minute incident/logs/api-2026-10-14.jsonl "db pool wait timeout" 14:18 14:24` → `14:20 44`, `14:21 74`, `14:22 83` |
| 14:29 | `/health` весь час відповідає 200 | `incident/oncall-chat.md:17` |
| 14:36 | Провайдер SMS: інцидентів у них немає | `incident/oncall-chat.md:18` |
| 14:46:58 | Остання `503` | `node docs/rca-queries.mjs find incident/logs/api-2026-10-14.jsonl "db pool wait timeout"` → рядок `last` з `"ts":"2026-10-14T14:46:58.204+03:00"`, `"status":503` |
| 14:47:00 | Відкат на v1.7.3; `db_pool_in_use` = 14, черги немає, p95 618 → 296 мс | `incident/deploys.log:9`; `node docs/rca-queries.mjs rows incident/metrics/2026-10-14.csv 14:45 14:49 rps,p95_ms,error_rate,db_pool_in_use,db_pool_waiting` → `14:46,11.1,4697,0.1186,4,17`, `14:47,11.5,618,0.0014,14,0`, `14:48,11.4,296,0.0015,11,0` |
| 14:48 | Пейджі закрито | `incident/alerts.json:19`, `:27` |
| 15:03 | Закрито й `SmsProvider429RateHigh` — без жодних дій, як і щодня | `incident/alerts.json:11` |

## Першопричина

1. **Що змінилося.** Реліз v1.8.0 «config cleanup» відсортував змінні в `deploy/compose.yaml` за
   алфавітом і заодно перейменував `DB_POOL_MAX` на `DB_POOL_SIZE` — і для `api`, і для `worker`
   (`incident/changes/v1.8.0.diff:86-87`, `:106-107`; доказ 1). Код застосунку, що працює з
   пулом, не змінювався (докази 26–27).
2. **Що стало інакше.** `app/src/config.js:9` читає лише `DB_POOL_MAX`; невідому змінну
   `DB_POOL_SIZE` ніхто не читає, і застосунок мовчки бере значення за замовчуванням — **4**
   (коментар над ним — «sensible default for local dev», `app/src/config.js:8`; доказ 4). Пул
   API зменшився з 20 до 4 з'єднань.
3. **Чому саме зараз.** О 14:02 — денний пік (~11–12 rps), за якого API тримає 10–13 з'єднань
   одночасно (так само 13.10 — 9–13). Чотирьох не вистачає: решта запитів стає в чергу пулу
   (`db_pool_waiting` до 23; докази 5–14).
4. **Чому саме цей симптом.** Хто чекає на з'єднання понад `DB_POOL_WAIT_MS` = 2000 мс, отримує
   `PoolTimeoutError` (`app/src/db.js:74-77`), а API перетворює її на
   `503 {"error":"service busy, try again"}` (`app/src/server.js:65`) — екран поштомата показує
   «Сервіс зайнятий». Найбільше страждає видача: `pickup` бере з'єднання тричі поспіль
   (`app/src/parcels.js:61`, `:64`, `:67`), тож має три шанси впасти; 2586 із 3380 відповідей 503
   — саме `/pickup` (докази 15, 16, 16a). p95 — 4,5 с, бо запит, що двічі постояв у черзі, триває
   понад 2 с.
5. **Чому перезапуск не допоміг, а відкат допоміг.** О 14:20 перезапустили лише API на тій самій
   v1.8.0 — `restart`, а не новий деплой (доказ 18; `incident/deploys.log:8`). Змінних
   оточення контейнера в даних немає, але їхній ефект видно: пул і після перезапуску стояв
   рівно на 4 з чергою (доказ 19a), а тайм-аути тривали (доказ 19). Відкат на v1.7.3 (докази 3a, 3b) повернув `compose.yaml` з
   `DB_POOL_MAX: "20"` (доказ 3) — пул знову 20 (у першу ж хвилину зайнято 14, доказ 3c), черга зникла, остання 503 — за 2 с
   до старту v1.7.3 (докази 15, 18).

## Докази

| # | Твердження | Команда (з кореня репо) | Результат |
|---|---|---|---|
| 1 | Реліз v1.8.0 перейменував `DB_POOL_MAX` на `DB_POOL_SIZE` в обох сервісах | `node docs/rca-queries.mjs lines incident/changes/v1.8.0.diff DB_POOL` | `86: -      DB_POOL_MAX: "20"`, `87: +      DB_POOL_SIZE: "20"`, `106: -      DB_POOL_MAX: "20"`, `107: +      DB_POOL_SIZE: "20"`, а також незмінні `88:        DB_POOL_WAIT_MS: "2000"` і `108:        DB_POOL_WAIT_MS: "2000"` |
| 2 | У `compose.yaml` v1.8.0 є змінна, якої застосунок не читає | `node docs/rca-queries.mjs env-unread incident/changes/v1.8.0.diff new` | `never read: DB_POOL_SIZE` |
| 3 | У `compose.yaml` v1.7.3 — старій стороні диффу релізу — застосунок читає кожну змінну | `node docs/rca-queries.mjs env-unread incident/changes/v1.8.0.diff old` | `set in incident/changes/v1.8.0.diff (old): TZ, PORT, LOG_LEVEL, DATABASE_URL, DB_POOL_MAX, DB_POOL_WAIT_MS, SMS_BASE_URL, SMS_TOKEN, SMS_RATE_PER_SEC, COURIER_BASE_URL`; `never read: none` |
| 3a | О 14:47 відкотили саме на v1.7.3 | `node docs/rca-queries.mjs lines incident/deploys.log rollback` | `9: 2026-10-14T14:47:00+03:00   rollback  v1.7.3   olena   on-call, just in case` |
| 3b | Після відкату API справді працював на v1.7.3 | `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "service started" ts,version 14:47 16:00` | `1 ts=2026-10-14T14:47:00.236+03:00  version=1.7.3` |
| 3c | Після відкату пул API знову перевищив 4 | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv db_pool_in_use 14:47 16:00` | `n=73 avg=6.45 min=2 max=14` |
| 4 | `config.js` не читає `DB_POOL_SIZE` і бере пул 4; з `DB_POOL_MAX` — 20 | `node --input-type=module -e "import { loadConfig } from './app/src/config.js'; console.log(loadConfig({ DB_POOL_SIZE: '20' }).dbPoolMax, loadConfig({ DB_POOL_MAX: '20' }).dbPoolMax)"` | `4 20` |
| 5 | Під v1.8.0 зайнято рівно 4 з'єднання пулу API, весь час | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv db_pool_in_use 14:02 14:47` | `n=45 avg=4.00 min=4 max=4` |
| 6 | До деплою пул тримав до 13 з'єднань | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv db_pool_in_use 12:00 14:02` | `n=122 avg=6.62 min=2 max=13` |
| 7 | Після відкату — знову до 14 | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv db_pool_in_use 14:47 16:00` | `n=73 avg=6.45 min=2 max=14` |
| 8 | Під v1.8.0 запити стояли в черзі пулу | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv db_pool_waiting 14:02 14:47` | `n=45 avg=17.31 min=4 max=23` |
| 9 | До деплою черги не було | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv db_pool_waiting 12:00 14:02` | `n=122 avg=0.00 min=0 max=0` |
| 10 | Після відкату черги не було | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv db_pool_waiting 14:47 16:00` | `n=73 avg=0.00 min=0 max=0` |
| 11 | 13.10 у той самий час API тримав 9–13 з'єднань | `node docs/rca-queries.mjs metric incident/baseline/metrics-2026-10-13.csv db_pool_in_use 13:30 15:00` | `n=90 avg=11.48 min=9 max=13` |
| 12 | 13.10 навантаження було таке саме | `node docs/rca-queries.mjs metric incident/baseline/metrics-2026-10-13.csv rps 13:30 15:00` | `n=90 avg=11.62 min=10.2 max=12.8` |
| 13 | Навантаження під час інциденту | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv rps 14:02 14:47` | `n=45 avg=11.80 min=11 max=12.8` |
| 14 | 13.10 черги пулу не було за весь проміжок, за який є метрики, — 12:00–16:00 (240 хвилин) | `node docs/rca-queries.mjs metric incident/baseline/metrics-2026-10-13.csv db_pool_waiting 12:00 16:00` | `n=240 avg=0.00 min=0 max=0` |
| 15 | Тайм-аути пулу — лише між деплоєм і відкатом | `node docs/rca-queries.mjs find incident/logs/api-2026-10-14.jsonl "db pool wait timeout"` | `count 3380`<br>`first {"ts":"2026-10-14T14:02:07.172+03:00","level":"error","msg":"request failed","method":"POST","path":"/parcels","status":503,"ms":2007,"error":"db pool wait timeout after 2000ms"}`<br>`last  {"ts":"2026-10-14T14:46:58.204+03:00","level":"error","msg":"request failed","method":"POST","path":"/pickup","status":503,"ms":3628,"error":"db pool wait timeout after 2000ms"}` |
| 16 | Усі 503 у лозі API за 14.10 — тайм-аут пулу, з іншою помилкою немає жодного | `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "request failed" status,error` | `3380 status=503  error=db pool wait timeout after 2000ms`<br>`125 status=500  error=Cannot read properties of undefined (reading 'trim')` — окремий щоденний баг |
| 16b | Лог API містить усі відповіді 5xx, а не вибірку: записів 5xx у лозі рівно стільки, скільки випливає з метрик (`rps × 60 × error_rate` по хвилинах) — і 14.10, і 13.10 | 14.10: `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "request failed" status` і `node docs/rca-queries.mjs est-5xx incident/metrics/2026-10-14.csv`<br>13.10: `node docs/rca-queries.mjs group incident/baseline/api-2026-10-13.jsonl "request failed" status` і `node docs/rca-queries.mjs est-5xx incident/baseline/metrics-2026-10-13.csv` | 14.10: `3380 status=503`, `125 status=500` (разом 3505) і `5xx implied by metrics: 3505`<br>13.10: `128 status=500` і `5xx implied by metrics: 128` |
| 16a | Під v1.8.0 503 найбільше на видачі | `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "request failed" status,path,error 14:02 14:47` | `2586 status=503  path=/pickup  error=db pool wait timeout after 2000ms`<br>`650 status=503  path=/parcels  error=db pool wait timeout after 2000ms`<br>`144 status=503  path=/admin/parcels  error=db pool wait timeout after 2000ms`<br>`52 status=500  path=/parcels  error=Cannot read properties of undefined (reading 'trim')` |
| 17 | 13.10 тайм-аутів пулу не було жодного | `node docs/rca-queries.mjs find incident/baseline/api-2026-10-13.jsonl "db pool wait timeout"` | `count 0` |
| 18 | Версії API на 14.10: v1.8.0 о 14:02 і 14:20, v1.7.3 о 14:47 | `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "service started" ts,version` | `ts=2026-10-14T14:02:00.087+03:00 version=1.8.0`; `ts=2026-10-14T14:20:31.112+03:00 version=1.8.0`; `ts=2026-10-14T14:47:00.236+03:00 version=1.7.3` |
| 19 | Перезапуск тієї ж версії о 14:20 не змінив нічого | `node docs/rca-queries.mjs per-minute incident/logs/api-2026-10-14.jsonl "db pool wait timeout" 14:18 14:24` | `14:18 78`, `14:19 88`, `14:20 44`, `14:21 74`, `14:22 83`, `14:23 92` |
| 19a | Після перезапуску о 14:20 пул API так само рівно 4, з чергою: фактичний розмір пулу не змінився | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv db_pool_in_use 14:21 14:47` і `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv db_pool_waiting 14:21 14:47` | `n=26 avg=4.00 min=4 max=4` і `n=26 avg=17.38 min=14 max=20` |
| 20 | p95 під v1.8.0 — ~4,5 с | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv p95_ms 14:02 14:47` | `n=45 avg=4476.16 min=945 max=4962` |
| 21 | p95 до деплою — ~0,2 с | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv p95_ms 12:00 14:02` | `n=122 avg=189.44 min=140 max=262` |
| 22 | p95 після відкату — ~0,2 с (618 мс — у хвилину відкату) | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv p95_ms 14:47 16:00` | `n=73 avg=193.34 min=140 max=618` |
| 23 | Частка 5xx під v1.8.0 — ~11 % | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv error_rate 14:02 14:47` | `n=45 avg=0.11 min=0.0042 max=0.1347` |
| 24 | До деплою — менше 0,5 % | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv error_rate 12:00 14:02` | `n=122 avg=0.00 min=0 max=0.0046` |
| 25 | Після відкату — менше 1 % | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv error_rate 14:47 16:00` | `n=73 avg=0.00 min=0 max=0.0072` |
| 26 | Реліз змінив 5 файлів; з коду — лише `app/src/worker.js` | `node docs/rca-queries.mjs lines incident/changes/v1.8.0.diff "diff --git"` | `1: diff --git a/app/README.md b/app/README.md`<br>`13: diff --git a/app/package.json b/app/package.json`<br>`25: diff --git a/app/src/worker.js b/app/src/worker.js`<br>`47: diff --git a/app/test/worker.test.js b/app/test/worker.test.js`<br>`66: diff --git a/deploy/compose.yaml b/deploy/compose.yaml` |
| 27 | API не працює з SMS-провайдером — його адресу бере лише worker | `node docs/rca-queries.mjs lines app/src/server.js sms` і `node docs/rca-queries.mjs lines app/src/worker.js smsBaseUrl` | перша — порожній вивід; друга — `45:     baseUrl: config.smsBaseUrl,` |

## Що з даних НЕ є причиною — і чим це доведено

Кожен пункт спростування — окрема команда і її вивід.

| Гіпотеза | Чому виглядала правдоподібно | Чим спростовано (команда → результат) |
|---|---|---|
| SMS-провайдер «душить» нас `429` | Алерт о 13:37, ще до 503; у логах worker тисячі `sms provider rate limited` (`incident/oncall-chat.md:10`) | **Стільки ж 429 і в звичайний день:** `node docs/rca-queries.mjs count incident/logs/worker-2026-10-14.jsonl "sms provider rate limited"` → `count 3065`; `node docs/rca-queries.mjs count incident/baseline/worker-2026-10-13.jsonl "sms provider rate limited"` → `count 2935`.<br>**429 почалися за 34 хв до 503:** `node docs/rca-queries.mjs above incident/metrics/2026-10-14.csv sms_429_per_min 0` → `first 13:28`; `node docs/rca-queries.mjs find incident/logs/api-2026-10-14.jsonl "db pool wait timeout"` → рядок `first` з `"ts":"2026-10-14T14:02:07.172+03:00"`.<br>**429 тривали після відкату, а 503 — ні:** `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv sms_429_per_min 14:47 16:00` → `max=45`; `node docs/rca-queries.mjs count incident/logs/api-2026-10-14.jsonl "db pool wait timeout" 14:47 16:00` → `count 0`.<br>**429 отримує worker, а тайм-аутів пулу в нього немає:** `node docs/rca-queries.mjs count incident/logs/worker-2026-10-14.jsonl "db pool wait timeout"` → `count 0` |
| Провайдер SMS «почав глючити» — `TLS handshake timeout` о 14:01:37 | Помилка за 21 с до перших проблем (`incident/oncall-chat.md:13`) | **Одна за день — і така сама напередодні:** `node docs/rca-queries.mjs find incident/logs/worker-2026-10-14.jsonl "TLS handshake"` → `count 1`, `14:01:37.954`; `node docs/rca-queries.mjs find incident/baseline/worker-2026-10-13.jsonl "TLS handshake"` → `count 1`, `13:12:45.343`.<br>**API до провайдера не звертається:** `node docs/rca-queries.mjs lines app/src/server.js sms` → порожній вивід; `node docs/rca-queries.mjs lines app/src/worker.js smsBaseUrl` → `45:     baseUrl: config.smsBaseUrl,`.<br>Провайдер підтвердив, що інцидентів не мав: `incident/oncall-chat.md:18` |
| Витік пам'яті в API — `heap usage high`, heap 81 % | Попередження в логах API під час інциденту (`incident/oncall-chat.md:11`) | **Діапазон heap до, під час і після інциденту однаковий, і верхня межа ніде не перевищила 82 %:** `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv heap_used_pct 12:00 14:02` → `min=54 max=82`; `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv heap_used_pct 14:02 14:47` → `min=42 max=82`; `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv heap_used_pct 14:47 16:00` → `min=44 max=82`. Це порівняння діапазонів, а не аналіз тренду всередині проміжків.<br>**Той самий діапазон 13.10:** `node docs/rca-queries.mjs metric incident/baseline/metrics-2026-10-13.csv heap_used_pct 12:00 16:00` → `min=54 max=82`.<br>**Попереджень 13.10 навіть більше:** `node docs/rca-queries.mjs count incident/logs/api-2026-10-14.jsonl "heap usage high"` → `count 63`; `node docs/rca-queries.mjs count incident/baseline/api-2026-10-13.jsonl "heap usage high"` → `count 70`.<br>**Помилки — тайм-аути пулу, а не пам'ять:** `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "request failed" status,path,error 14:02 14:47` → 3380 з 3432 — `db pool wait timeout after 2000ms`, решта 52 — баг `trim` (останній рядок таблиці) |
| Зросло навантаження (післяобідні партії посилок) | Інцидент — у пік, rps ~12 | **Під час інциденту rps майже такий самий, як за пів години до нього, коли помилок не було:** `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv rps 14:02 14:47` → `avg=11.80`; `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv rps 13:30 14:02` → `avg=11.57`.<br>**Такий самий rps 13.10 — без черги і без тайм-аутів:** `node docs/rca-queries.mjs metric incident/baseline/metrics-2026-10-13.csv rps 13:30 15:00` → `avg=11.62`; `node docs/rca-queries.mjs metric incident/baseline/metrics-2026-10-13.csv db_pool_waiting 12:00 16:00` → `max=0`; `node docs/rca-queries.mjs find incident/baseline/api-2026-10-13.jsonl "db pool wait timeout"` → `count 0` |
| Новий текст SMS у v1.8.0 | Єдина зміна коду в релізі | **Змінено лише текст SMS і текст логу у worker** (контекст — `incident/changes/v1.8.0.diff`): `node docs/rca-queries.mjs lines incident/changes/v1.8.0.diff "diff --git"` → з коду лише `25: diff --git a/app/src/worker.js b/app/src/worker.js`; `node docs/rca-queries.mjs lines incident/changes/v1.8.0.diff "return "` → ``33: -  return `Посилка чекає у поштоматі №${parcel.lockerId}. Код: ${parcel.code}`;`` і ``34: +  return `Ваша посилка у поштоматі №${parcel.lockerId}. Код отримання: ${parcel.code}`;``; `node docs/rca-queries.mjs lines incident/changes/v1.8.0.diff "log.error("` → `42: -      log.error("sms send failed", { parcel_id: parcel.id, error: describeError(err) });` і `43: +      log.error("sms delivery failed", { parcel_id: parcel.id, error: describeError(err) });`.<br>**API реліз не змінював:** `node docs/rca-queries.mjs lines incident/changes/v1.8.0.diff "server.js"` → порожній вивід.<br>**Під v1.8.0 жодне SMS не впало** (нове повідомлення про помилку — рядок `43` вище): `node docs/rca-queries.mjs count incident/logs/worker-2026-10-14.jsonl "sms delivery failed"` → `count 0`; `node docs/rca-queries.mjs count incident/logs/worker-2026-10-14.jsonl "sms send failed" 14:02 14:47` → `count 0`.<br>**Розсилка йшла як завжди** (пачок за 45 хв до / під час / після): `node docs/rca-queries.mjs count incident/logs/worker-2026-10-14.jsonl "sms batch sent" 13:17 14:02` → `count 220`; `node docs/rca-queries.mjs count incident/logs/worker-2026-10-14.jsonl "sms batch sent" 14:02 14:47` → `count 211`; `node docs/rca-queries.mjs count incident/logs/worker-2026-10-14.jsonl "sms batch sent" 14:47 15:32` → `count 236`.<br>**А 503 віддає API, не worker:** `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "request failed" status,path,error 14:02 14:47` → `2586 status=503  path=/pickup  error=db pool wait timeout after 2000ms` (перший рядок виводу) |
| `500` на `POST /parcels` — `Cannot read properties of undefined (reading 'trim')` | Помилки 5xx є і в інциденті | **Щоденний окремий баг** (`app/src/parcels.js:42`, `sender.trim()` без перевірки): 13.10, весь день: `node docs/rca-queries.mjs group incident/baseline/api-2026-10-13.jsonl "request failed" status,path,error` → `128 status=500  path=/parcels  error=Cannot read properties of undefined (reading 'trim')`; 14.10, весь день: `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "request failed" status,path,error` → серед рядків `125 status=500  path=/parcels  error=Cannot read properties of undefined (reading 'trim')` — це 51 до деплою + 52 під час інциденту + 22 після відкату. По періодах 14.10 — до деплою: `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "request failed" status,path,error 12:00 14:02` → `51 status=500  path=/parcels  error=Cannot read properties of undefined (reading 'trim')`; під час інциденту: `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "request failed" status,path,error 14:02 14:47` → серед рядків `52 status=500  path=/parcels  error=Cannot read properties of undefined (reading 'trim')`; після відкату: `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "request failed" status,path,error 14:47 16:00` → `22 status=500  path=/parcels  error=Cannot read properties of undefined (reading 'trim')`.<br>**На рівень помилок не впливає:** `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv error_rate 12:00 14:02` → `max=0.0046` |
| v1.8.0 тримає з'єднання довше або не повертає їх у пул (альтернатива з `ai-runs/rca-v1.md`, «Припущення та обмеження») | Прогін 1 не бачив диффу і пояснював стелю 4 лише метрикою | **Код роботи з пулом реліз не змінював:** `node docs/rca-queries.mjs lines incident/changes/v1.8.0.diff "diff --git"` → 5 файлів: `app/README.md`, `app/package.json`, `app/src/worker.js`, `app/test/worker.test.js`, `deploy/compose.yaml` — немає `db.js`, `server.js`, `parcels.js`.<br>**Стелю 4 повністю пояснює конфіг:** `node --input-type=module -e "import { loadConfig } from './app/src/config.js'; console.log(loadConfig({ DB_POOL_SIZE: '20' }).dbPoolMax)"` → `4` |
| Хвиля SMS «приблизно в 10 разів більша за норму» (`ai-runs/rca-v1.md`) перевантажила систему | Почалася о 13:28, за пів години до інциденту | **Та сама хвиля щодня — і за 429, і за обсягом розсилки:** `node docs/rca-queries.mjs above incident/metrics/2026-10-14.csv sms_429_per_min 20` → `88 min, first 13:32, last 14:59`; `node docs/rca-queries.mjs above incident/baseline/metrics-2026-10-13.csv sms_429_per_min 20` → `86 min, first 13:32, last 14:57`; `node docs/rca-queries.mjs count incident/logs/worker-2026-10-14.jsonl "sms batch sent"` → `count 1242`; `node docs/rca-queries.mjs count incident/baseline/worker-2026-10-13.jsonl "sms batch sent"` → `count 1222`.<br>**SMS шле worker, у якого пул не вичерпувався:** `node docs/rca-queries.mjs count incident/logs/worker-2026-10-14.jsonl "db pool wait timeout"` → `count 0` |

## Чинники, що сприяли (contributing factors)

- **Конфіг мовчки ігнорує невідомі змінні й має небезпечне значення за замовчуванням.**
  Пул 4 — «для локальної розробки» (`app/src/config.js:8-9`), але без попередження діє і в
  продакшні; сервіс на старті логує лише версію, а не фактичний конфіг
  (`app/src/server.js:95`), тож у логах не видно, що пул став 4.
- **Немає перевірки, що змінні в `compose.yaml` — це ті, що читає застосунок.** Тести
  перевіряють `config.js` сам по собі — з `DB_POOL_MAX` і з дефолтом 4 як очікуваною поведінкою
  (`app/test/config.test.js:8`, `:17`, `:24`); перейменування в compose пройшло непоміченим.
- **Зміну конфігу сприйняли як косметичну** («нічого суттєвого — причесав конфіг»,
  `incident/oncall-chat.md:12`) і викотили в денний пік, о 14:02.
- **`/health` не зачіпає БД** (`app/src/server.js:37`) — відповідав 200 увесь інцидент
  (`incident/oncall-chat.md:17`), тож не підказав, що сервіс фактично не працює.
- **Шумний алерт відвів увагу.** `SmsProvider429RateHigh` спрацьовує щодня: 13.10
  `sms_429_per_min` був понад 20 протягом 86 хвилин
  (`node docs/rca-queries.mjs above incident/baseline/metrics-2026-10-13.csv sms_429_per_min 20`
  → `86 min, first 13:32, last 14:57`). Чергова почала з нього, а зв'язок з деплоєм о 14:02
  з'явився лише о 14:13, коли автор релізу сам про нього написав (`incident/oncall-chat.md:12`).
  Причина щоденних 429 — окрема: `SMS_RATE_PER_SEC: "20"` у тодішньому `compose.yaml`
  (`incident/changes/v1.8.0.diff:93`, `:112`) при ліміті провайдера 10/с
  (`materials/vendors/sms-provider.md:16`).
- **Немає метрики пулу в алертах.** `db_pool_waiting` > 0 з'явився о 14:02 — за 4 хв до першого
  пейджу (`incident/alerts.json:18`) і як пряма вказівка на причину
  (`node docs/rca-queries.mjs above incident/metrics/2026-10-14.csv db_pool_waiting 0` →
  `45 min, first 14:02, last 14:46`).

## Впевненість

**Висока.** Механізм відтворюється напряму (доказ 4: `DB_POOL_SIZE=20` → пул 4), а метрика
пулу рівно 4 збігається з життям v1.8.0 з точністю до хвилини в обидва боки (докази 5–10, 15,
18); усі 503 мають один текст — тайм-аут пулу (доказ 16), і лог містить усі 5xx (доказ 16b); за того ж навантаження напередодні
тайм-аутів не було (докази 11, 12, 14, 17). Чого бракує: застосунок не логує фактичний розмір
пулу, тож «4» видно лише з метрики, а не з логу старту; продакшн-адаптер PostgreSQL у репо
відсутній (`app/src/db.js:1-2`), тож поведінку пулу перевірено на тому самому інтерфейсі в
пам'яті. Висновок змінило б, якби з'ясувалося, що метрика `db_pool_in_use` рахує щось інше,
ніж пул API.

## Перша відповідь AI проти другої

| | `ai-runs/rca-v1.md` — алерти, логи, метрики | `ai-runs/rca-v2.md` — увесь `incident/` + `app/` + `deploy/` |
|---|---|---|
| Що AI назвав першопричиною | «Реліз 1.8.0, викочений о 14:02, обмежив пул з'єднань до БД до 4»; що саме всередині релізу — «виводжу з метрик», як альтернативу допускає «1.8.0 тримає з'єднання довше або не повертає їх у пул» | «У релізі v1.8.0 змінну оточення DB_POOL_MAX у deploy/compose.yaml перейменували на DB_POOL_SIZE… пул з'єднань із БД у API мовчки зменшився з 20 до 4» |
| Впевненість, яку заявив AI | «висока, приблизно 85–90 %» | «висока, близько 95 %» |
| Збігається з вашою? | частково — реліз, пул 4, механізм 503 і хронологія збігаються; конкретної причини (перейменування змінної) не назвав, а його альтернативну гіпотезу спростовано: `node docs/rca-queries.mjs lines incident/changes/v1.8.0.diff "diff --git"` → реліз не змінював `db.js`, `server.js`, `parcels.js` | так — та сама причина, той самий механізм до рядка коду (`config.js:9`, `server.js:65`, `parcels.js:61-67`) |
| Що в даних вплинуло на відповідь | — | **`incident/changes/v1.8.0.diff` + `app/src/config.js:9`** перетворили «щось у релізі тримає пул на 4» на конкретну причину: перейменована змінна і дефолт 4 (докази 1–4). **`incident/baseline/`** дав змогу відкинути 429, heap і TLS-тайм-аут як щоденний фон — прогін 1 відкидав їх лише за динамікою всередині дня і назвав хвилю SMS «у 10 разів більшою за норму», хоча вона щоденна: `node docs/rca-queries.mjs above incident/baseline/metrics-2026-10-13.csv sms_429_per_min 20` → `86 min` (14.10 — `88 min`). **`app/src/server.js:37`** пояснив, чому `/health` був зеленим, а **`app/test/config.test.js:8`, `:17`, `:24`** — чому тести не впали (вони перевіряють лише `DB_POOL_MAX` і закріплюють дефолт 4). Важливо: самих метрик і логів вистачило, щоб локалізувати проблему (реліз + пул) — додаткові дані дали механізм і впевненість |

Обидва прогони, як і цей RCA, відкинули гіпотези чергової з чату (429, «витік пам'яті»,
TLS-тайм-аут). Прогін 1 до того ж згадує неіснуючий «Helm» у переліку місць, де шукати
параметр пулу — у системі лише docker compose (`incident/deploys.log:1`).
