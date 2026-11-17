import {decodeJwt} from 'jose';
import {createClerkVerifier} from '../supabase/functions/univeracademy-api/clerk-auth.ts';
import {requireFreshDeletionProof} from '../supabase/functions/univeracademy-api/account-deletion.ts';
import {fail} from '../supabase/functions/univeracademy-api/fault.ts';

/** No unverified fva is accepted: decode the identical token only after the
 * existing issuer/azp/RS256/session verifier has verified its signature. */
export function createDeletionVerifier(config){
  return wrapDeletionVerifier(createClerkVerifier(config),config.now);
}
/** Trusted server seam; callers cannot supply this function via request/env. */
export function wrapDeletionVerifier(verify,now){
  if(typeof verify!=='function'||typeof now!=='function')fail('SERVICE_UNAVAILABLE',503);
  return async(token)=>{
    const proof=await verify(token),p=decodeJwt(token);
    if(!Array.isArray(p.fva)||p.fva.length!==2||!p.fva.every(x=>Number.isSafeInteger(x)&&x>=-1)||p.fva[0]<0||
      !Number.isSafeInteger(p.iat))fail('REVERIFICATION_REQUIRED',403);
    // fva is rounded to minutes. Use the conservative upper bound, plus token
    // age; an old token must not keep a recent verification fresh forever.
    const firstFactorVerifiedAfter=p.iat*1000-(p.fva[0]+1)*60000;
    const value=Object.freeze({proof,firstFactorVerifiedAfter});
    requireFreshDeletionProof(value,now());
    return value;
  };
}
