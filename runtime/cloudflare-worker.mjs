import {fetchNativeCabinet} from './cloudflare-cabinet-route.mjs';
import {withTelegramMenuCompletion} from './telegram-menu-completion.mjs';
import {WorkerEntrypoint} from 'cloudflare:workers';
import api from './cloudflare-entry.mjs';
import {createTelegramDirectory} from './cloudflare-telegram-directory.mjs';
import {createInviteSchedule} from './cloudflare-invite-schedule.mjs';

const directory=createTelegramDirectory(); // Inert factory; no client/config read.
// Bind the Bot to THIS named entrypoint, never the public/default fetch export.
// Platform capability wiring is a separate approved action. No public header or
// URL can select this class, and the method accepts only the contract input.
export class TelegramAccountDirectory extends WorkerEntrypoint{
 async lookupTelegramStart(input){return directory.lookupTelegramStart(input,this.env);}
 async fetch(){return new Response(null,{status:404,headers:{'cache-control':'no-store'}});}
}
// Bind only the bot to this separate named staging writer, with its own least-privilege database role.
export class TelegramPilotDirectory extends WorkerEntrypoint {
  async recordPilotPrivateStart(input) {
    if (this.env.UA_TELEGRAM_PILOT_DIRECTORY_ENABLED !== 'true') throw Error('SERVICE_UNAVAILABLE');
    const { recordStagingPrivateStart } = await import('./staging-private-start.mjs');
    return recordStagingPrivateStart(input, this.env);
  }
  async fetch() { return new Response(null, {status:404}); }
}
// Ustoz Pages binds directly to this staff-only entry point.
export class TeacherCabinetGateway extends WorkerEntrypoint {
  async fetch(request) { return fetchNativeCabinet(request,this.env,'staff'); }
}
export default {...withTelegramMenuCompletion(api), scheduled:createInviteSchedule()};
