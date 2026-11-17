import {fail} from './fault.ts';
import {checkClerkProof,requireLiveClerk} from './clerk-auth.ts';
import type {ClerkProof,ClerkLiveness} from './clerk-auth.ts';

export const DELETION_CONFIRMATION='delete-account-v1';
export type FreshDeletionProof={proof:ClerkProof;firstFactorVerifiedAfter:number};
export type DeletionStatus='pending'|'completed';
/** Server-only adapter. prepare MUST atomically lock/recheck current access,
 * bind the exact verified issuer/subject to that person, freeze writes/revoke
 * access, and store an idempotent job+receipt before returning. Never create a
 * person here. Provider HTTP must not run within the request transaction. */
export interface DeletionRequestStore {
  prepare(input:{accessToken:string;identity:ClerkProof;receiptHash:string;requestId:string;verifiedAfter:number}):Promise<void>;
  status(receiptHash:string):Promise<DeletionStatus|null>;
}
const receiptPattern=/^[A-Za-z0-9_-]{43}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export async function deletionReceiptHash(receipt:string):Promise<string>{
  if(!receiptPattern.test(receipt))fail('INVALID_REQUEST',400);
  const bytes=Uint8Array.from(atob(receipt.replace(/-/g,'+').replace(/_/g,'/')+'='),c=>c.charCodeAt(0));
  // Canonical base64url prevents multiple receipt spellings.
  if(bytes.length!==32||btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')!==receipt)fail('INVALID_REQUEST',400);
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(receipt));
  return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
}
export function requireFreshDeletionProof(value:FreshDeletionProof,now:number):void{
  checkClerkProof(value.proof,now);
  if(!Number.isSafeInteger(value.firstFactorVerifiedAfter)||value.firstFactorVerifiedAfter<0||
    value.firstFactorVerifiedAfter>now||now-value.firstFactorVerifiedAfter>=300000)fail('REVERIFICATION_REQUIRED',403);
}
export function createDeletionRequests(options:{enabled:boolean;store:DeletionRequestStore;
  verify:(token:string)=>Promise<FreshDeletionProof>;liveness:ClerkLiveness;now:()=>number}){
  return Object.freeze({
    async submit(input:{accessToken:string;clerkToken:string;receipt:string;requestId:string;confirmation:string}){
      if(!options.enabled)fail('NOT_FOUND',404);
      if(input.confirmation!==DELETION_CONFIRMATION||!uuidPattern.test(input.requestId)||
        typeof input.accessToken!=='string'||!input.accessToken||input.accessToken.length>4096||
        typeof input.clerkToken!=='string'||!input.clerkToken||input.clerkToken.length>16384)fail('INVALID_REQUEST',400);
      const receiptHash=await deletionReceiptHash(input.receipt);
      const verified=await options.verify(input.clerkToken);
      requireFreshDeletionProof(verified,options.now());
      await requireLiveClerk(verified.proof,options.now(),options.liveness);
      requireFreshDeletionProof(verified,options.now());
      await options.store.prepare({accessToken:input.accessToken,identity:verified.proof,receiptHash,
        requestId:input.requestId,verifiedAfter:verified.firstFactorVerifiedAfter});
      return {status:'pending' as const};
    },
    async status(receipt:string){
      // Status intentionally remains available when new acceptance is disabled.
      const value=await options.store.status(await deletionReceiptHash(receipt));
      if(value===null)fail('NOT_FOUND',404);
      if(value!=='pending'&&value!=='completed')fail('SERVICE_UNAVAILABLE',503);
      return {status:value};
    },
  });
}
export interface DeletionLease {jobId:string;leaseId:string;issuer:string;userId:string;}
export interface DeletionRecoveryStore {
  /** Claims only already accepted, frozen jobs; random lease ID fences every mutation. */
  claim():Promise<DeletionLease|null>;
  providerDeleted(lease:DeletionLease):Promise<void>;
  /** Atomic graph cleanup, old-subject tombstone and Telegram unlink. */
  finish(lease:DeletionLease):Promise<void>;
}
export function createDeletionRecovery(options:{enabled:boolean;issuer:string;store:DeletionRecoveryStore;
  removeProvider:(userId:string,issuer:string)=>Promise<'deleted'|'absent'>}){
  return async()=>{
    if(!options.enabled)return {processed:false};
    const lease=await options.store.claim();if(!lease)return {processed:false};
    if(lease.issuer!==options.issuer||!/^user_[A-Za-z0-9]+$/.test(lease.userId))fail('SERVICE_UNAVAILABLE',503);
    // Any ambiguous provider or DB failure leaves the frozen durable job for a
    // later lease. Never unfreeze or report completed after an uncertain result.
    const result=await options.removeProvider(lease.userId,lease.issuer);
    if(result!=='deleted'&&result!=='absent')fail('SERVICE_UNAVAILABLE',503);
    await options.store.providerDeleted(lease);
    await options.store.finish(lease);
    return {processed:true};
  };
}
