# Telegram-бот записи на тренировки

Бот для записи клиентов на тренировки. Расписание и записи хранятся в Google Таблице (Source of Truth). Админ может править таблицу вручную и управлять слотами через команды бота.

## Стек

- Node.js 20+
- TypeScript
- [grammY](https://grammy.dev/)
- Google Sheets API (`googleapis`)

## Быстрый старт

### 1. Создайте бота

1. Откройте [@BotFather](https://t.me/BotFather) в Telegram.
2. Команда `/newbot` — получите **BOT_TOKEN**.

### 2. Узнайте свой Telegram ID

1. Напишите [@userinfobot](https://t.me/userinfobot) или [@getmyid_bot](https://t.me/getmyid_bot).
2. Скопируйте числовой **Id** — это `ADMIN_ID`.

### 3. Google Service Account (SERVICE_ACCOUNT_JSON)

1. Откройте [Google Cloud Console](https://console.cloud.google.com/).
2. Создайте проект (или выберите существующий).
3. Перейдите в **APIs & Services → Library**, найдите **Google Sheets API** и нажмите **Enable**.
4. Перейдите в **APIs & Services → Credentials → Create Credentials → Service Account**.
5. Задайте имя (например, `bot-zapisi`), создайте аккаунт.
6. Откройте сервисный аккаунт → вкладка **Keys → Add Key → Create new key → JSON**.
7. Скачанный файл сохраните как:

```text
credentials/service-account.json
```

8. Откройте JSON и скопируйте поле `client_email` (вида `xxx@xxx.iam.gserviceaccount.com`).

### 4. Доступ к таблице

1. Откройте таблицу:  
   https://docs.google.com/spreadsheets/d/1HJ1ybpDpw8Cyt-hEpUG2rTDOcHWBup5xJVvIo2ZSLwE/edit
2. Нажмите **Настройки доступа** (Share).
3. Вставьте `client_email` сервисного аккаунта.
4. Выдайте роль **Редактор** (Editor) и сохраните.

### 5. Структура таблицы (3 листа)

Бот сам создаёт листы при `/seed_demo` или первом обращении.

**Работники:** Имя | Активен (да/нет)

**Услуги:** Название | Длительность_мин | Цена | Активен

**Расписание:** Дата | Время | Работник | Услуга | Статус | Имя 1 | Телефон 1 | Имя 2 | Телефон 2 | Примечание

Клиентский сценарий: услуга → специалист → день → время (кнопки).
Админ: `/admin` — демо-данные, работники, услуги, слоты, ручная запись.

### 6. Установка и запуск

```bash
npm install
cp .env.example .env
```

Заполните `.env`:

```env
BOT_TOKEN=ваш_токен_от_BotFather
ADMIN_ID=ваш_telegram_id
SPREADSHEET_ID=ваш_id_таблицы
SHEET_NAME=Расписание
GOOGLE_CREDENTIALS_PATH=./credentials/service-account.json
TIMEZONE=Europe/Moscow
SLOT_CAPACITY=2
WORK_START=10:00
WORK_END=20:00
SLOT_INTERVAL_MINUTES=90
```

Запуск:

```bash
npm run dev
```

или

```bash
npm start
```

## Команды

### Клиент

| Команда / действие | Описание |
|--------------------|----------|
| `/start` | Приветствие и кнопка записи |
| «Записаться на тренировку» | Список свободных слотов на 7 дней |
| `/cancel` | Отмена своей активной записи |
| `/book` | То же, что кнопка записи |

### Администратор (`ADMIN_ID`)

| Команда | Описание |
|---------|----------|
| `/admin` | Меню управления |
| `/bookings` | Записи на сегодня и завтра |
| `/seed_demo` | Демо: 3 работника, 3 услуги, слоты на неделю |
| `/generate_schedule` | Слоты на 7 дней для всех работников |
| `/add_worker` | Добавить специалиста |
| `/add_service` | Добавить услугу |
| `/add_slot` | Добавить один слот |
| `/manual_book` | Записать клиента вручную |
| `/clear_slot` | Полностью освободить слот |

## Структура проекта

```text
src/
  main.ts
  config.ts
  context.ts
  types.ts
  keyboards/
  middlewares/
  handlers/
  services/googleSheets.ts
```

## Важно

- Не коммитьте `.env` и `credentials/service-account.json`.
- Если слот заняли между выбором и подтверждением, бот сообщит об этом и покажет обновлённый список.
- Профиль клиента (имя/телефон) хранится в сессии бота до перезапуска; после рестарта бот спросит данные снова.
