import { privatePng } from '../packages/test-content/worker-private-image.mjs';
import { createCabinetApi } from './teacher-cabinet-api.mjs';
import { createWorkerCabinetHandler } from './cloudflare-cabinet.mjs';

// Only the factory is shared. Each fetch owns its database and Clerk resources.
export const cabinet = createWorkerCabinetHandler({
  createApi: options => createCabinetApi(options, privatePng),
});
