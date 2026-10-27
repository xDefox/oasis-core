/**
 * F1-8: экран первого входа — ник и «как играть».
 *
 * Зонды (puppeteer, navigator.webdriver) и уже прошедшие онбординг
 * пропускают экран, чтобы CI не зависал на форме.
 */

const ONBOARDED_KEY = 'oasis.onboarded';

export interface OnboardingResult {
  name: string;
  /** true — показали экран, false — пропустили. */
  shown: boolean;
}

function isAutomated(): boolean {
  return Boolean((navigator as { webdriver?: boolean }).webdriver);
}

export function alreadyOnboarded(): boolean {
  return window.localStorage.getItem(ONBOARDED_KEY) === '1';
}

export function markOnboarded(): void {
  window.localStorage.setItem(ONBOARDED_KEY, '1');
}

/**
 * Показывает ворота входа. Резолвится с выбранным ником.
 * Если экран не нужен — сразу возвращает suggestedName.
 */
export function runOnboarding(suggestedName: string): Promise<OnboardingResult> {
  if (isAutomated() || alreadyOnboarded()) {
    return Promise.resolve({ name: suggestedName, shown: false });
  }

  const root = document.getElementById('onboarding');
  const form = document.getElementById('onboarding-form') as HTMLFormElement | null;
  const input = document.getElementById('onboarding-name') as HTMLInputElement | null;
  const hint = document.getElementById('hint');

  if (!root || !form || !input) {
    return Promise.resolve({ name: suggestedName, shown: false });
  }

  root.hidden = false;
  root.setAttribute('aria-hidden', 'false');
  if (hint) hint.hidden = true;
  input.value = suggestedName.startsWith('guest-') ? '' : suggestedName;
  input.placeholder = suggestedName;
  // Небольшой кадр — чтобы фокус сработал после появления.
  requestAnimationFrame(() => input.focus());

  return new Promise((resolve) => {
    const finish = (raw: string) => {
      const name = raw.trim() || suggestedName;
      markOnboarded();
      root.hidden = true;
      root.setAttribute('aria-hidden', 'true');
      if (hint) {
        hint.hidden = false;
        // «2 минуты до движения» по смыслу плана: подсказка живёт ~2 мин, потом гаснет.
        window.setTimeout(() => {
          hint.classList.add('hint-fade');
        }, 120_000);
      }
      resolve({ name, shown: true });
    };

    form.addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        finish(input.value);
      },
      { once: true },
    );
  });
}
