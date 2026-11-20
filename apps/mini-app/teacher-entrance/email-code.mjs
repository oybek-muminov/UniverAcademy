// Clerk can return or throw an error. Keep account-specific outcomes indistinguishable.
const privateErrors = new Set([
  'form_identifier_not_found', 'identifier_not_found', 'factor_not_found',
  'user_locked', 'user_banned', 'sign_in_not_allowed_for_user',
]);
export async function requestTeacherEmailCode(signIn, emailAddress) {
  try {
    const { error } = await signIn.emailCode.sendCode({ emailAddress });
    if (error) throw error;
    if (typeof signIn.id !== 'string' || !signIn.id) throw new Error();
    return signIn.id;
  } catch (error) {
    if (privateErrors.has(error?.code) || error?.errors?.some(item => privateErrors.has(item.code))) return null;
    throw error;
  }
}
