import type { Env } from './types.ts';
import { HttpError, log } from './util.ts';

export async function tg(env: Env, method: string, body: any) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j: any = null; try { j = await r.json(); } catch { /* ignore */ }
  if (!r.ok || !j?.ok) { log('tg_error', { method, status: r.status, desc: j?.description }); throw new HttpError(502, 'telegram_error', { description: j?.description }); }
  return j.result;
}
export type Lang = 'ru' | 'kk' | 'en';
export const TXT: Record<Lang, Record<string, string>> = {
  ru: { welcome: 'Добро пожаловать в CAD x FORGE — магазин цифровых лекал одежды.', open: 'Открыть магазин', paid: 'Оплата прошла успешно. Файлы доступны в разделе «Мои покупки».', purchases: 'Открыть мои покупки', pay: 'Вопросы по оплате: напишите в поддержку и укажите номер заказа.', admin: 'Админ-панель', notadmin: 'Нет доступа.' },
  kk: { welcome: 'CAD x FORGE — киімнің сандық қалыптары дүкеніне қош келдіңіз.', open: 'Дүкенді ашу', paid: 'Төлем сәтті өтті. Файлдар «Сатып алғандарым» бөлімінде қолжетімді.', purchases: 'Сатып алғандарымды ашу', pay: 'Төлем сұрақтары бойынша қолдау қызметіне тапсырыс нөмірін көрсетіп жазыңыз.', admin: 'Әкімші панелі', notadmin: 'Қолжетімсіз.' },
  en: { welcome: 'Welcome to CAD x FORGE — digital clothing patterns.', open: 'Open store', paid: 'Payment successful. Your files are in My purchases.', purchases: 'Open my purchases', pay: 'Payment questions: contact support and mention your order number.', admin: 'Admin panel', notadmin: 'Access denied.' },
};
export const pickLang = (l?: string | null): Lang => (l && /^(ru|kk|en)/.test(l) ? (l.slice(0, 2) as Lang) : 'en');
export const send = (env: Env, chat_id: number, text: string, url?: string, btn?: string) =>
  tg(env, 'sendMessage', { chat_id, text, ...(url ? { reply_markup: { inline_keyboard: [[{ text: btn, web_app: { url } }]] } } : {}) });
