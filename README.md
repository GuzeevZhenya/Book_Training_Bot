# Telegram-бот записи на тренировки

Бот для записи клиентов к тренерам. **Google Sheets** — источник правды: расписание, записи, профили клиентов и здоровье.

Репозиторий: [GuzeevZhenya/Book_Training_Bot](https://github.com/GuzeevZhenya/Book_Training_Bot)

## Возможности

### Клиент
- `/start` — онбординг один раз: имя, Telegram-тег, опционально проблемы со здоровьем
- **Записаться** — тренер → день → время → услуга (имя и @username подставляются сами)
- **Мои записи** / **Отменить** — по Telegram ID
- **Здоровье** — указать / изменить / очистить; при каждой записи текст попадает в колонки «Здоровье 1/2»
- **Мои данные** — имя, Telegram, здоровье

### Тренер
- Кнопка **Клиенты: …**, если в листе «Работники» указан Telegram
- В списке клиентов видно ⚠️ и текст проблем со здоровьем
- Личный лист в той же таблице (синхронизируется с «Расписание»)

### Админ (`ADMIN_ID` и/или `ADMIN_USERNAMES`)
- Админ-панель: тренеры, услуги, расписание дня/недели, ручная запись
- Добавление тренера: уникальность по **Telegram-тегу**; если имя уже есть — обновляется привязка тега
- Очистка расписания и записей (листы Работники / Услуги / Клиенты не трогаются)

## Стек

- Node.js 20+
- TypeScript
- [grammY](https://grammy.dev/) + conversations
- Google Sheets API (`googleapis`)

## Быстрый старт

### 1. Бот

1. [@BotFather](https://t.me/BotFather) → `/newbot` → **BOT_TOKEN**

### 2. Админы

- Числовой id: [@userinfobot](https://t.me/userinfobot) → `ADMIN_ID`
- И/или username через запятую: `ADMIN_USERNAMES=DarinaDv2,Guzeev_96`

### 3. Google Service Account

1. [Google Cloud Console](https://console.cloud.google.com/) → проект
2. Включить **Google Sheets API**
3. Credentials → Service Account → ключ JSON
4. Сохранить, например: `credentials/service-account.json`
5. Скопировать `client_email` из JSON

### 4. Таблица

1. Создайте Google Spreadsheet (или используйте существующую)
2. **Доступ** → добавьте `client_email` с ролью **Редактор**
3. ID таблицы из URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`

**Не** оформляйте листы как «Формат → Преобразовать в таблицу» — бот пишет обычные ячейки; Table-объекты ломают дописывание строк.

### 5. Листы (создаются сами)

| Лист | Колонки |
|------|---------|
| **Работники** | Имя, Активен, Telegram, Ссылка на лист |
| **Услуги** | Название, Длительность_мин, Цена, Активен |
| **Клиенты** | Telegram ID, Имя, Телефон, Username, Проблемы со здоровьем, Обновлено |
| **Расписание** | Дата, Время, Работник, Услуга, Статус, Имя 1, Телефон 1, Имя 2, Телефон 2, Примечание, Здоровье 1, Здоровье 2 |
| **Лист тренера** | Копия строк этого тренера из «Расписание» |

Слот: до 2 человек, шаг по умолчанию 90 минут (`10:00`–`20:00`).

### 6. Установка

```bash
npm install
cp .env.example .env
```

```env
BOT_TOKEN=...
ADMIN_ID=...
ADMIN_USERNAMES=DarinaDv2,Guzeev_96
SPREADSHEET_ID=...
SHEET_NAME=Расписание
GOOGLE_CREDENTIALS_PATH=./credentials/service-account.json
TIMEZONE=Europe/Moscow
SLOT_CAPACITY=2
WORK_START=10:00
WORK_END=20:00
SLOT_INTERVAL_MINUTES=90
```

```bash
npm start
# или
npm run dev
```

**Важно:** запускайте только **один** экземпляр бота (иначе Telegram 409 Conflict).

## Скрипты обслуживания

```bash
npx tsx scripts/clear-schedule.ts      # очистить Расписание + листы тренеров
npx tsx scripts/repair-sheet.ts          # починить даты/время/стили
npx tsx scripts/fix-table-format.ts    # убрать Google Table-объекты, перезаписать данные
npx tsx scripts/sync-trainer-sheets.ts   # синхронизировать листы тренеров
npx tsx scripts/fix-bookings.ts         # починить привязки записей
```

## Команды и кнопки

### Клиент

| Действие | Описание |
|----------|----------|
| `/start` | Онбординг или меню |
| 📅 Записаться | Мастер записи |
| 📋 Мои записи | Будущие визиты |
| 🩺 Здоровье | Проблемы для тренера |
| 👤 Мои данные | Профиль |
| ❌ Отменить запись | Отмена по Telegram ID |
| ℹ️ Информация | Краткая справка |

### Админ / тренер

| Действие | Описание |
|----------|----------|
| 🛠 Админ-панель | Тренеры, услуги, слоты, очистка, демо |
| 👥 Клиенты: Имя | Записи привязанного тренера |

## Структура проекта

```text
src/
  main.ts
  config.ts
  handlers/     # start, booking, cancel, admin
  keyboards/
  services/googleSheets.ts
  middlewares/
scripts/        # clear / repair / sync
```

## Важно

- Не коммитьте `.env` и JSON ключи service account.
- Профили клиентов хранятся в листе **Клиенты** (переживают рестарт бота).
- При частых кликах возможна квота Sheets API (~60 чтений/мин) — подождите минуту; в коде есть кэш запросов.
- После очистки расписания заново сгенерируйте неделю/день в админ-панели.
