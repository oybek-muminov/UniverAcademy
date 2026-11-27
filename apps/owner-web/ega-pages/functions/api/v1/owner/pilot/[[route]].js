import { forwardTeacherStaging } from '../../../../../../../../runtime/teacher-staging-proxy.mjs';

// The Owner site carries its dashboard and two commands, nothing else, through its own service binding (OwnerCabinetGateway).
// The shared route table decides which Owner paths exist; every other path is refused before the gateway.
export function onRequest({ request, env }) {
  return forwardTeacherStaging(request, env, { surface: 'owner' });
}
