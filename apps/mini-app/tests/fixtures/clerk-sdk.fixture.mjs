// Test-only public SDK facade. No Clerk instance, provider request or SDK secret.
export function fakeClerkSdk(options = {}) {
  const calls = [];
  let active = null, serial = 0;
  const makeSession = id => ({ id, status: 'active', currentTask: null,
    getToken: async input => { calls.push(['getToken', input]); return options.token ? options.token(id, input) : 'synthetic-sdk-proof-' + id; } });
  const resource = kind => ({ status: 'needs_identifier', createdSessionId: null, isTransferable: false,
    reset: async () => { calls.push([kind + '.reset']); return options.reset ? options.reset() : { error: null }; },
    create: async input => {
      calls.push([kind + '.create', input]);
      if (options.create) return options.create(kind, input);
      if (kind === 'signUp') { sdk.signUp.status = 'complete'; sdk.signUp.createdSessionId = 'sess_Synthetic' + ++serial; }
      return { error: null };
    },
    emailCode: {
      sendCode: async () => { calls.push(['sendCode']); return options.send ? options.send() : { error: null }; },
      verifyCode: async input => {
        calls.push(['verifyCode', input]);
        if (options.verify) return options.verify(input);
        sdk.signIn.status = 'complete'; sdk.signIn.createdSessionId = 'sess_Synthetic' + ++serial; return { error: null };
      },
    },
    sso: async input => {
      calls.push(['sso', { strategy: input.strategy, redirectUrl: input.redirectUrl, redirectCallbackUrl: input.redirectCallbackUrl }]);
      if (options.sso) return options.sso(input);
      sdk.signIn.status = 'complete'; sdk.signIn.createdSessionId = 'sess_Synthetic' + ++serial; return { error: null };
    },
    finalize: async input => {
      calls.push([kind + '.finalize']);
      if (options.finalize) return options.finalize(kind, input, id => { active = makeSession(id); });
      const session = makeSession(sdk[kind].createdSessionId);
      await input.navigate?.({ session, decorateUrl: value => value }); active = session; return { error: null };
    },
  });
  const popup = { close() { calls.push(['popup.close']); } };
  const sdk = {
    signIn: resource('signIn'), signUp: resource('signUp'), session: () => active,
    signOut: async id => { calls.push(['signOut', id]); if (options.signOut) await options.signOut(id); if (active?.id === id) active = null; },
    openPopup: () => { calls.push(['popup.open']); return options.popupBlocked ? null : popup; },
    callbackUrl: 'https://app.example.test/auth/callback',
  };
  return { sdk, calls, setSession(value) { active = value; }, makeSession };
}
