/**
 * Перевод между игроками: чистая логика (F1-22).
 *
 * Комиссия — сток по docs/05: деньги сгорают, а не переходят кому-то.
 * Сгорает она с отправителя сверху, поэтому получатель видит ровно ту
 * сумму, которую назвал отправитель: обмануть переводом нельзя.
 */

import { PAY_FEE_FREE_LIMIT, PAY_FEE_RATE } from '@oasis/protocol';

/** Комиссия с суммы: 0 до лимита, 5 % свыше. */
export function payFeeOf(amount: number): number {
  return amount > PAY_FEE_FREE_LIMIT ? Math.round(amount * PAY_FEE_RATE) : 0;
}

/** Сколько списывается с отправителя: сумма + комиссия. */
export function payTotalOf(amount: number): number {
  return amount + payFeeOf(amount);
}

/**
 * Сумма из аргументов команды: целое от 1 и не больше. Всё остальное —
 * не сумма: «10.5», «-5», «1e3» и пустая строка отклоняются здесь же,
 * а не доезжают до ledger.
 */
export function parsePayAmount(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,9}$/.test(raw)) return null;
  const amount = Number.parseInt(raw, 10);
  return amount >= 1 ? amount : null;
}
