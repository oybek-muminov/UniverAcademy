// Kanal a'zoligi shart bo'lganda serverdan keladigan javobni tanish (faqat mantiq, ekran emas).
export const CHANNEL_REQUIRED_CODE = 'CHANNEL_MEMBERSHIP_REQUIRED';
export function isChannelRequired(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { kind?: unknown }).kind === 'forbidden'
    && (error as { code?: unknown }).code === CHANNEL_REQUIRED_CODE;
}
