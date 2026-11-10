import { createDemoPort } from './demo-port.ts';
import { createCommonEntryPrototype, EntryDemoFailure } from './common-entry-prototype.ts';

// DEV-only simulation. No Clerk SDK, JWT, OAuth URL, fetch, email delivery or store.
export function createCommonEntryDemo(context: 'browser' | 'telegram_webview' = 'browser', fault: 'none' | 'cancelled' | 'app_denied' | 'code_expired' | 'provider_offline' = 'none') {
  let serial = 0, currentChallenge = '';
  const later = () => new Promise(resolve => setTimeout(resolve, 180));
  return createCommonEntryPrototype({ mode: 'synthetic', context,
    provider: {
      async google() { await later(); if (fault === 'cancelled') throw new EntryDemoFailure('CANCELLED'); if (fault === 'provider_offline') throw new Error('synthetic-private-provider-error'); return { proof: 'synthetic-google-evidence' }; },
      async sendCode(_email) { await later(); if (fault === 'provider_offline') throw new Error('synthetic-private-provider-error'); currentChallenge = 'synthetic-challenge-' + ++serial; return { challenge: currentChallenge }; },
      async verifyCode(challenge, code) {
        await later();
        if (fault === 'code_expired' || challenge !== currentChallenge) throw new EntryDemoFailure('CODE_EXPIRED');
        if (code !== '246810') throw new EntryDemoFailure('INVALID_CODE');
        return { proof: 'synthetic-email-evidence' };
      },
    },
    async authorize(evidence) {
      await later();
      if (fault === 'app_denied') throw new EntryDemoFailure('APP_DENIED');
      if (!['synthetic-google-evidence', 'synthetic-email-evidence'].includes(evidence.proof)) throw new EntryDemoFailure('APP_DENIED');
      const demo = createDemoPort();
      const registered = await demo.port.register('Suniy', 'Kirish');
      // Explicit fixture enrollment. No email/Telegram linking or staff grant.
      return { person: registered.person, port: demo.port };
    },
  });
}
