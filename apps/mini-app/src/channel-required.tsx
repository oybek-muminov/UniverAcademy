// Kanal a'zoligi shart bo'lganda ko'rsatiladigan ekran (faqat kabineti bor o'quvchiga).
// Kanal havolasi ochiq ma'lumot; serverdagi sozlama bilan bir xil bo'lishi kerak.
export const CHANNEL_URL: string = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_REQUIRED_CHANNEL_URL
  || 'https://t.me/PhysicsHubUZ';
export function ChannelRequiredCard() {
  return <section className="card"><h1>Kanalga a‘zo bo‘ling</h1>
    <p role="status">Kabinetga kirish uchun avval rasmiy kanalimizga a‘zo bo‘ling, so‘ng “Tekshirish” tugmasini bosing.</p>
    <p><a className="primary" href={CHANNEL_URL} target="_blank" rel="noopener noreferrer">Kanalga o‘tish</a></p>
    <button type="button" onClick={() => location.reload()}>Tekshirish</button></section>;
}
