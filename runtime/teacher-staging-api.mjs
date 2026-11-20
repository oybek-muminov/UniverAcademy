// Node composition retained for the existing gateway and local pilot.
import { privatePng } from '../packages/test-content/private-image.mjs';
import { createCabinetApi } from './teacher-cabinet-api.mjs';

export function createTeacherStagingApi(options = {}) {
  return createCabinetApi(options, privatePng);
}
