import {verifyTelegramLaunch} from '../supabase/functions/univeracademy-api/telegram-return.ts';
import {readChannelGate,checkChannelMembership} from './channel-membership.mjs';

export const CHANNEL_REQUIRED_CODE='CHANNEL_MEMBERSHIP_REQUIRED';

/** Mini App qayta ochilganda (resume) chaqiriladi. Faqat quyidagi holatda kanal
 * ma'lumotini qaytaradi: kanal tekshiruvi yoqilgan, odam ANIQ kanalda emas, bazada
 * kabineti bor (linked) va xodim emas. Boshqa hamma holatda (yangi o'quvchi, xodim,
 * Telegram yoki baza xatosi, noto'g'ri sozlama) null — ya'ni kiritiladi.
 * Hech qachon xato tashlamaydi va resume'ning o'zini o'zgartirmaydi.
 * isLinked/isStaff — server portlari: (telegramUserId) => Promise<boolean>. */
export async function channelGateBlocks({request,env,bindings,fetcher,now,isLinked,isStaff}){
  try{
    const gate=readChannelGate(env);if(!gate)return null;
    const body=JSON.parse(await request.clone().text());
    const raw=body?.init_data;if(typeof raw!=='string'||!raw)return null;
    // Imzo/muddat noto'g'ri bo'lsa, odatiy resume o'zining xatosini beradi.
    const launch=await verifyTelegramLaunch(raw,bindings.botToken,bindings.sessionPolicy,now());
    const id=launch.telegramUserId;
    const status=await checkChannelMembership({token:bindings.botToken,channel:gate.channel,userId:id,fetcher});
    if(status!=='not_member')return null;
    if(await isLinked(id)!==true)return null; // Yangi o'quvchidan kanal so'ralmaydi.
    if(await isStaff(id)!==false)return null; // Xodim yoki noaniq — kiritiladi.
    return gate;
  }catch{return null;}
}
