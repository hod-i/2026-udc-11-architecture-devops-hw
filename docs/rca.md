# RCA: інцидент 2026-10-14 — поштомати не видають посилки

Усі команди запускаються з кореня репо і працюють однаково в Git Bash, PowerShell і cmd:
запити до логів і метрик — `docs/rca-queries.mjs` (Node 22+, без залежностей; опис команд —
у шапці файлу). Часові межі `[від, до)` — за Europe/Kyiv.

## Коротко

З 14:02 до 14:47 API відповідав `503 service busy` на ~11 % запитів, і мешканці бачили на
екрані поштомата «Сервіс зайнятий» замість видачі посилки. Причина — реліз v1.8.0, який
перейменував у `compose.yaml` змінну `DB_POOL_MAX` на `DB_POOL_SIZE`: застосунок такої змінної
не читає і мовчки взяв пул з'єднань за замовчуванням — 4 замість 20, а на денне навантаження
потрібно 10–13. Відкат на v1.7.3 повернув пул 20, і помилки зникли за секунди.

## Хронологія (Europe/Kyiv)

| Час | Подія | Джерело (файл або команда) |
|---|---|---|
| 13:28 | Перші `429` від SMS-провайдера — як і щодня (13.10 — з 13:32) | `node docs/rca-queries.mjs rows incident/metrics/2026-10-14.csv 13:25 13:30 sms_429_per_min` |
| 13:37 | Алерт `SmsProvider429RateHigh` (warning) | `incident/alerts.json:7-12` |
| 13:40 | Чергова бачить 429, SMS доходять — вирішує не втручатися | `incident/oncall-chat.md:6` |
| 14:01:37 | Одна помилка `TLS handshake timeout to sms.example.net` у worker | `node docs/rca-queries.mjs find incident/logs/worker-2026-10-14.jsonl "TLS handshake"` |
| 14:01:58 | API отримує SIGTERM — початок деплою v1.8.0 «config cleanup» | `incident/deploys.log:7`; `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "shutting down" ts` |
| 14:02:00 | API v1.8.0 стартував; у цю ж хвилину `db_pool_in_use` = 4 (до того 12), з'являється черга | `node docs/rca-queries.mjs rows incident/metrics/2026-10-14.csv 14:00 14:05 rps,p95_ms,error_rate,db_pool_in_use,db_pool_waiting` |
| 14:02:07 | Перша `503 db pool wait timeout after 2000ms` | `node docs/rca-queries.mjs find incident/logs/api-2026-10-14.jsonl "db pool wait timeout"` |
| 14:06 / 14:07 | Пейджі `ApiLatencyP95High` і `Api5xxRateHigh` | `incident/alerts.json:15-28` |
| 14:08 | Гаряча лінія: «Сервіс зайнятий» на поштоматах | `incident/oncall-chat.md:9` |
| 14:10–14:14 | Чергова підозрює 429 від провайдера, heap 81 % і TLS-тайм-аут; автор релізу: «нічого суттєвого — причесав конфіг» | `incident/oncall-chat.md:10-14` |
| 14:20:31 | Перезапуск лише API, та сама v1.8.0 — не допомагає (503 далі: 74 за 14:21) | `incident/deploys.log:8`; `node docs/rca-queries.mjs per-minute incident/logs/api-2026-10-14.jsonl "db pool wait timeout" 14:18 14:24` |
| 14:29 | `/health` весь час відповідає 200 | `incident/oncall-chat.md:17` |
| 14:36 | Провайдер SMS: інцидентів у них немає | `incident/oncall-chat.md:18` |
| 14:46:58 | Остання `503` | `node docs/rca-queries.mjs find incident/logs/api-2026-10-14.jsonl "db pool wait timeout"` |
| 14:47:00 | Відкат на v1.7.3; `db_pool_in_use` = 14, черги немає, p95 618 → 296 мс | `incident/deploys.log:9`; `node docs/rca-queries.mjs rows incident/metrics/2026-10-14.csv 14:45 14:49 rps,p95_ms,error_rate,db_pool_in_use,db_pool_waiting` |
| 14:48 | Пейджі закрито | `incident/alerts.json:19`, `:27` |
| 15:03 | Закрито й `SmsProvider429RateHigh` — без жодних дій, як і щодня | `incident/alerts.json:11` |

## Першопричина

1. **Що змінилося.** Реліз v1.8.0 «config cleanup» відсортував змінні в `deploy/compose.yaml` за
   алфавітом і заодно перейменував `DB_POOL_MAX` на `DB_POOL_SIZE` — і для `api`, і для `worker`
   (`incident/changes/v1.8.0.diff:86-87`, `:106-107`). Код застосунку при цьому не змінювався.
2. **Що стало інакше.** `app/src/config.js:9` читає лише `DB_POOL_MAX`; невідому змінну
   `DB_POOL_SIZE` ніхто не читає, і застосунок мовчки бере значення за замовчуванням — **4**
   (коментар над ним — «sensible default for local dev», `app/src/config.js:8`). Пул API
   зменшився з 20 до 4 з'єднань.
3. **Чому саме зараз.** О 14:02 — денний пік (~11–12 rps), за якого API тримає 10–13 з'єднань
   одночасно (так само 13.10 — 9–13). Чотирьох не вистачає: решта запитів стає в чергу пулу
   (`db_pool_waiting` до 23).
4. **Чому саме цей симптом.** Хто чекає на з'єднання понад `DB_POOL_WAIT_MS` = 2000 мс, отримує
   `PoolTimeoutError` (`app/src/db.js:74-77`), а API перетворює її на
   `503 {"error":"service busy, try again"}` (`app/src/server.js:65`) — екран поштомата показує
   «Сервіс зайнятий». Найбільше страждає видача: `pickup` бере з'єднання тричі поспіль
   (`app/src/parcels.js:61`, `:64`, `:67`), тож має три шанси впасти; 2586 із 3380 відповідей 503
   — саме `/pickup`. p95 — 4,5 с, бо запит, що двічі постояв у черзі, триває понад 2 с.
5. **Чому перезапуск не допоміг, а відкат допоміг.** Перезапуск о 14:20 підняв ту саму v1.8.0 з
   тим самим конфігом. Відкат на v1.7.3 повернув `compose.yaml` з `DB_POOL_MAX: "20"` — пул знову
   20 (у першу ж хвилину зайнято 14), черга зникла, остання 503 — за 2 с до старту v1.7.3.

## Докази

| # | Твердження | Команда (з кореня репо) | Результат |
|---|---|---|---|
| 1 | Реліз v1.8.0 перейменував `DB_POOL_MAX` на `DB_POOL_SIZE` | `node docs/rca-queries.mjs env-unread incident/changes/v1.8.0.diff` | `set in incident/changes/v1.8.0.diff but never read: DB_POOL_SIZE`; рядки — `incident/changes/v1.8.0.diff:86-87`, `:106-107` |
| 2 | Застосунок не читає `DB_POOL_SIZE` і бере пул 4 | `node --input-type=module -e "import { loadConfig } from './app/src/config.js'; console.log(loadConfig({ DB_POOL_SIZE: '20' }).dbPoolMax, loadConfig({ DB_POOL_MAX: '20' }).dbPoolMax)"` | `4 20` |
| 3 | У конфігу v1.7.3 (до релізу і після відкату) усі змінні читаються | `node docs/rca-queries.mjs env-unread deploy/compose.yaml` | `set in deploy/compose.yaml but never read: none` |
| 4 | Від 14:02 до 14:47 пул API рівно 4 і є черга; до і після — до 13–14 і черги немає | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv db_pool_in_use 14:02 14:47` (і так само для `12:00 14:02`, `14:47 16:00`; колонка `db_pool_waiting`) | `in_use`: `min=4 max=4` під час; `max=13` до; `max=14` після. `waiting`: `avg=17.31 max=23` під час; `max=0` до і після |
| 5 | Навантаження не змінилося: такий самий трафік 13.10 потребував 9–13 з'єднань | `node docs/rca-queries.mjs metric incident/baseline/metrics-2026-10-13.csv db_pool_in_use 13:30 15:00` і `... rps 13:30 15:00` | `min=9 max=13`; rps `avg=11.62` (14.10 під час інциденту — `avg=11.80`) |
| 6 | Усі 503 — тайм-аут пулу, і всі — між деплоєм і відкатом | `node docs/rca-queries.mjs find incident/logs/api-2026-10-14.jsonl "db pool wait timeout"` | `count 3380`; перша `14:02:07.172`, остання `14:46:58.204` |
| 7 | 503 б'ють передусім по видачі | `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "request failed" status,path,error 14:02 14:47` | `/pickup` — 2586, `/parcels` — 650, `/admin/parcels` — 144 (усі `503 db pool wait timeout after 2000ms`) |
| 8 | 13.10 тайм-аутів пулу не було жодного | `node docs/rca-queries.mjs find incident/baseline/api-2026-10-13.jsonl "db pool wait timeout"` | `count 0` |
| 9 | Симптом стартує разом з v1.8.0 і зникає разом з нею | `node docs/rca-queries.mjs group incident/logs/api-2026-10-14.jsonl "service started" ts,version` | `14:02:00 1.8.0`, `14:20:31 1.8.0`, `14:47:00 1.7.3` — порівняти з рядком 6 |
| 10 | Перезапуск тієї ж версії не змінив нічого | `node docs/rca-queries.mjs per-minute incident/logs/api-2026-10-14.jsonl "db pool wait timeout" 14:18 14:24` | `14:19 88`, `14:20 44`, `14:21 74`, `14:22 83` |
| 11 | Затримка й помилки — лише на час v1.8.0 | `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv p95_ms 14:02 14:47` (і `error_rate`; і для `12:00 14:02`, `14:47 16:00`) | p95 `avg=4476` під час проти `189` до і `193` після; error_rate `avg=0.11` під час проти `0.00` |

## Що з даних НЕ є причиною — і чим це доведено

| Гіпотеза | Чому виглядала правдоподібно | Чим спростовано (команда → результат) |
|---|---|---|
| SMS-провайдер «душить» нас `429` | Алерт о 13:37, ще до 503; у логах worker тисячі `sms provider rate limited` (`incident/oncall-chat.md:10`) | Те саме щодня: `node docs/rca-queries.mjs msgs incident/baseline/worker-2026-10-13.jsonl` → `2935 warn sms provider rate limited` (14.10 — `3065`). 429 почалися о 13:28, а 503 — лише о 14:02, і 429 тривають після відкату: `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv sms_429_per_min 14:47 16:00` → `max=45`. До того ж 429 отримує worker, а 503 віддає API — окремий процес з окремим пулом |
| Провайдер SMS «почав глючити» — `TLS handshake timeout` о 14:01:37 | Помилка за 21 с до перших проблем (`incident/oncall-chat.md:13`) | Одна-єдина за день, і така сама була 13.10: `node docs/rca-queries.mjs find incident/baseline/worker-2026-10-13.jsonl "TLS handshake"` → `count 1`, `13:12:45`. API до SMS-провайдера не звертається взагалі — адресу провайдера бере лише worker (`app/src/worker.js:45`). Провайдер підтвердив, що інцидентів не мав (`incident/oncall-chat.md:18`) |
| Витік пам'яті в API — `heap usage high`, heap 81 % | Попередження в логах API під час інциденту (`incident/oncall-chat.md:11`) | Пилка 42–82 % — звичайна робота збирача сміття, без росту: `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv heap_used_pct 12:00 14:02` → `max=82`, `14:02 14:47` → `max=82`, `14:47 16:00` → `max=82`; 13.10 → `max=82`. Попереджень 13.10 навіть більше: `msgs incident/baseline/api-2026-10-13.jsonl` → `70 warn heap usage high` (14.10 — `63`). Помилки — тайм-аути пулу, а не нестача пам'яті (доказ 6) |
| Зросло навантаження (післяобідні партії посилок) | Інцидент — у пік, rps ~12 | Той самий rps 13.10 обслуговувався без жодного тайм-ауту (докази 5 і 8); rps під час інциденту (`avg=11.80`) майже такий самий, як о 13:30–14:02, коли помилок не було: `node docs/rca-queries.mjs metric incident/metrics/2026-10-14.csv rps 13:30 14:02` → `avg=11.57` |
| Новий текст SMS у v1.8.0 | Єдина зміна коду в релізі (`incident/changes/v1.8.0.diff:33-34`, `:42-43`) | Змінено лише текст SMS і текст логу у worker; API, через який іде видача, не змінювався. 503 віддає API (доказ 7) |
| `500` на `POST /parcels` — `Cannot read properties of undefined (reading 'trim')` | Помилки 5xx є і в інциденті | Окремий баг (`app/src/parcels.js:42`, `sender.trim()` без перевірки), не пов'язаний з інцидентом: є весь день 14.10 і 13.10 — `node docs/rca-queries.mjs group incident/baseline/api-2026-10-13.jsonl "request failed" status,path,error` → `128 status=500 path=/parcels ...`; на рівень помилок не впливає (`error_rate` до деплою `max=0.0046`) |
| v1.8.0 тримає з'єднання довше або не повертає їх у пул (альтернатива з `ai-runs/rca-v1.md`, «Припущення та обмеження») | Прогін 1 не бачив диффу і пояснював стелю 4 лише метрикою | Код роботи з пулом і API реліз не змінював — лише README, `package.json`, текст SMS у worker, його тест і `compose.yaml`: `node docs/rca-queries.mjs lines incident/changes/v1.8.0.diff "diff --git"` → 5 файлів, серед них немає `db.js`, `server.js`, `parcels.js`. Стелю 4 повністю пояснює конфіг (доказ 2) |
| Хвиля SMS «приблизно в 10 разів більша за норму» (`ai-runs/rca-v1.md`) перевантажила систему | Почалася о 13:28, за пів години до інциденту | Та сама хвиля щодня: 13.10 `sms_429_per_min` > 20 протягом 86 хв, з 13:32 (див. рядок про 429); SMS шле worker, а пул вичерпано в API (доказ 7) |

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
- **Шумний алерт відвів увагу.** `SmsProvider429RateHigh` спрацьовує щодня: 13.10 `sms_429_per_min`
  був понад 20 протягом 86 хвилин. Чергова почала з нього, а зв'язок з деплоєм о 14:02 з'явився
  лише о 14:13, коли автор релізу сам про нього написав. Причина щоденних 429 — окрема:
  `SMS_RATE_PER_SEC: "20"` у `deploy/compose.yaml:20` при ліміті провайдера 10/с
  (`materials/vendors/sms-provider.md:16`).
- **Немає метрики пулу в алертах.** `db_pool_waiting` > 0 з'явився о 14:02 — за 4 хв до першого
  пейджу і як пряма вказівка на причину.

## Впевненість

**Висока.** Механізм відтворюється напряму (доказ 2: `DB_POOL_SIZE=20` → пул 4), а метрика
пулу рівно 4 збігається з життям v1.8.0 з точністю до хвилини в обидва боки (докази 4, 6, 9);
усі 503 мають один текст — тайм-аут пулу (доказ 7); за того ж навантаження напередодні
тайм-аутів не було (докази 5, 8). Чого бракує: застосунок не логує фактичний розмір пулу, тож
«4» видно лише з метрики, а не з логу старту; продакшн-адаптер PostgreSQL у репо відсутній
(`app/src/db.js:1-2`), тож поведінку пулу перевірено на тому самому інтерфейсі в пам'яті.
Висновок змінило б, якби з'ясувалося, що метрика `db_pool_in_use` рахує щось інше, ніж пул API.

## Перша відповідь AI проти другої

| | `ai-runs/rca-v1.md` — алерти, логи, метрики | `ai-runs/rca-v2.md` — увесь `incident/` + `app/` + `deploy/` |
|---|---|---|
| Що AI назвав першопричиною | «Реліз 1.8.0, викочений о 14:02, обмежив пул з'єднань до БД до 4»; що саме всередині релізу — «виводжу з метрик», як альтернативу допускає «1.8.0 тримає з'єднання довше або не повертає їх у пул» | «У релізі v1.8.0 змінну оточення DB_POOL_MAX у deploy/compose.yaml перейменували на DB_POOL_SIZE… пул з'єднань із БД у API мовчки зменшився з 20 до 4» |
| Впевненість, яку заявив AI | «висока, приблизно 85–90 %» | «висока, близько 95 %» |
| Збігається з вашою? | частково — реліз, пул 4, механізм 503 і хронологія збігаються; конкретної причини (перейменування змінної) не назвав, а його альтернативну гіпотезу спростовано (див. «що НЕ є причиною») | так — та сама причина, той самий механізм до рядка коду (`config.js:9`, `server.js:65`, `parcels.js:61-67`) |
| Що в даних вплинуло на відповідь | — | **`incident/changes/v1.8.0.diff` + `app/src/config.js:9`** перетворили «щось у релізі тримає пул на 4» на конкретну причину: перейменована змінна і дефолт 4. **`incident/baseline/`** дав змогу відкинути 429, heap і TLS-тайм-аут як щоденний фон (прогін 1 відкидав їх лише за динамікою всередині дня — і назвав хвилю SMS «у 10 разів більшою за норму», хоча вона щоденна). **`app/src/server.js:37`** пояснив, чому `/health` був зеленим, а **`app/test/config.test.js:8`, `:17`, `:24`** — чому тести не впали (вони перевіряють лише `DB_POOL_MAX` і закріплюють дефолт 4). Важливо: самих метрик і логів вистачило, щоб локалізувати проблему (реліз + пул) — додаткові дані дали механізм і впевненість |

Обидва прогони, як і цей RCA, відкинули гіпотези чергової з чату (429, «витік пам'яті»,
TLS-тайм-аут). Прогін 1 до того ж згадує неіснуючий «Helm» у переліку місць, де шукати
параметр пулу — у системі лише docker compose (`deploy/compose.yaml:1`).
