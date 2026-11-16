// Contract path inventory only. Recognition does not activate an operation.
export const contractPaths=Object.freeze([
  "/admin/assignments",
  "/admin/groups/{group_id}/members",
  "/admin/students/{student_id}/transfer",
  "/admin/versions/{version_id}",
  "/admin/versions/{version_id}/publish",
  "/admin/versions/{version_id}/questions/{question_id}",
  "/attempts/{attempt_id}",
  "/attempts/{attempt_id}/answers/{question_id}",
  "/attempts/{attempt_id}/result",
  "/attempts/{attempt_id}/submit",
  "/auth/clerk",
  "/auth/logout",
  "/auth/refresh",
  "/auth/telegram",
  "/auth/telegram/link",
  "/auth/telegram/resume",
  "/exams",
  "/exams/{assignment_id}",
  "/exams/{assignment_id}/attempts",
  "/exams/{assignment_id}/history",
  "/me"
]);
const patterns=contractPaths.map(path=>new RegExp("^/api/v1"+path.replace(/\{[a-z_]+\}/g,"[^/]+")+"/?$"));
export const isContractPath=pathname=>patterns.some(pattern=>pattern.test(pathname));
