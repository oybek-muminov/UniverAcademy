import { forwardTeacherStaging } from '../../../../../../../../runtime/teacher-staging-proxy.mjs';

// The Owner site carries one read, nothing else, through its own service binding (OwnerCabinetGateway).
export function onRequest({ request, env }) {
  return forwardTeacherStaging(request, env, { surface: 'owner' });
}
