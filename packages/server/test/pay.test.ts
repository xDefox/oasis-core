/**
 * Перевод между игроками (F1-22): комиссия и разбор суммы.
 *
 * Комиссия — деньги, которые сгорают. Считает её сервер, поэтому проверяется
 * здесь: до лимита её нет, свыше — 5 % и входят в сумму списания.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PAY_FEE_FREE_LIMIT, PAY_FEE_RATE } from '@oasis/protocol';

import { parsePayAmount, payFeeOf, payTotalOf } from '../src/chat/pay.ts';

describe('перевод: комиссия', () => {
  it('перевод: до лимита комиссии нет', () => {
    assert.equal(payFeeOf(1), 0);
    assert.equal(payFeeOf(999), 0);
    assert.equal(payFeeOf(PAY_FEE_FREE_LIMIT), 0);
    assert.equal(payTotalOf(10), 10);
  });

  it('перевод: свыше лимита комиссия 5 % и входит в итог списания', () => {
    assert.equal(payFeeOf(PAY_FEE_FREE_LIMIT + 1), Math.round((PAY_FEE_FREE_LIMIT + 1) * PAY_FEE_RATE));
    assert.equal(payFeeOf(2_000), 100);
    // Отправитель платит сумму плюс комиссию, получатель — ровно сумму.
    assert.equal(payTotalOf(2_000), 2_100);
  });

  it('перевод: сумма — целое от 1, остальное не сумма', () => {
    assert.equal(parsePayAmount('10'), 10);
    assert.equal(parsePayAmount('1'), 1);
    for (const raw of [undefined, '', '0', '-5', '10.5', '1e3', 'тысяча', '99999999999']) {
      assert.equal(parsePayAmount(raw), null, `«${raw}» не должно быть суммой`);
    }
  });
});
