export type SlotStatus = "Свободно" | "1/2" | "Занято";

export interface Worker {
  rowIndex: number;
  name: string;
  active: boolean;
  /** Telegram username без @ — для кнопки «клиенты тренера» */
  telegram?: string;
  /** Ссылка на личный лист тренера в таблице */
  sheetUrl?: string;
}


export interface Service {
  rowIndex: number;
  name: string;
  durationMin: number;
  price: number;
  active: boolean;
}

export interface Slot {
  rowIndex: number;
  date: string;
  time: string;
  worker: string;
  service: string;
  status: SlotStatus;
  clientName: string;
  clientContact: string;
  clientName2: string;
  clientContact2: string;
  note: string;
  /** Проблемы со здоровьем клиента на месте 1 */
  health1: string;
  /** Проблемы со здоровьем клиента на месте 2 */
  health2: string;
  bookedCount: number;
  freeSeats: number;
}

export interface ClientProfile {
  rowIndex: number;
  telegramId: string;
  name: string;
  phone: string;
  username: string;
  healthIssues: string;
  updatedAt: string;
}

export interface SessionData {
  clientName?: string;
  clientPhone?: string;
  pendingService?: string;
  pendingWorker?: string;
  pendingDate?: string;
  pendingTime?: string;
  /** Индекс тренера в админ-мастере */
  adminTrainerIndex?: number;
}

export class SlotAlreadyBookedError extends Error {
  constructor(date: string, time: string, worker?: string) {
    super(
      worker
        ? `Слот ${date} ${time} (${worker}) уже занят`
        : `Слот ${date} ${time} уже занят`,
    );
    this.name = "SlotAlreadyBookedError";
  }
}

export class SlotNotFoundError extends Error {
  constructor(date: string, time: string, worker?: string) {
    super(
      worker
        ? `Слот ${date} ${time} (${worker}) не найден`
        : `Слот ${date} ${time} не найден`,
    );
    this.name = "SlotNotFoundError";
  }
}
