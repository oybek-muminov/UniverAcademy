import {WorkerEntrypoint} from 'cloudflare:workers';
import api from './cloudflare-entry.mjs';
import {createTelegramDirectory} from './cloudflare-telegram-directory.mjs';

const directory=createTelegramDirectory(); // Inert factory; no client/config read.
// Bind the Bot to THIS named entrypoint, never the public/default fetch export.
// Platform capability wiring is a separate approved action. No public header or
// URL can select this class, and the method accepts only the contract input.
export class TelegramAccountDirectory extends WorkerEntrypoint{
 async lookupTelegramStart(input){return directory.lookupTelegramStart(input,this.env);}
 async fetch(){return new Response(null,{status:404,headers:{'cache-control':'no-store'}});}
}
export default api;
