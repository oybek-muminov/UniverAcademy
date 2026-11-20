import { forwardTeacherStaging } from '../../../../../../../../runtime/teacher-staging-proxy.mjs';

export function onRequest({ request, env }) {
  return forwardTeacherStaging(request, env, { surface: 'teacher' });
}
