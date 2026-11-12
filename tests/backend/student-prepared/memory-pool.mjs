// Test-only statement dispatcher. No SQL parser, database, listener, file store,
// provider or credential. It proves JS statement/control flow, never RLS/DDL.
import {initialState,clock} from '../http-fixture.ts';
import assert from 'node:assert/strict';
import {encodePublished} from '../../../supabase/functions/univeracademy-api/storage/attempt-rows.ts';
export class MemoryPool {
  state=initialState(); now=clock; events=[]; checkouts=0; answerBranches=[];
  attempts={}; series={}; results={}; answers={}; receipts={}; bindings={}; identities=[]; fences=[];
  failCommit; failAt; before; locatorPerson; onStatement;
  async connect(){
    this.checkouts++;const clientId=this.checkouts;let d;
    const rows=(rows=[])=>({rows,rowCount:rows.length}),ack=()=>rows([{}]);
    return {release:discard=>this.events.push({name:'release',clientId,discard:!!discard}),query:async q=>{
      const {name,values:v}=q;this.events.push({name,clientId,values:structuredClone(v)});
      await this.onStatement?.(name);if(this.failAt===name)throw Error('offline statement failure');
      if(['ua_begin','ua_clerk_begin','ua_locator_begin'].includes(name)){d=structuredClone({state:this.state,attempts:this.attempts,series:this.series,results:this.results,answers:this.answers,receipts:this.receipts,bindings:this.bindings,identities:this.identities,fences:this.fences});return rows();}
      if(name==='ua_commit'||name==='ua_clerk_commit'){
        if(this.failCommit==='before')throw Error('offline commit unknown');
        Object.assign(this,d);if(this.failCommit==='after')throw Error('offline commit unknown');return rows();
      }
      if(['ua_rollback','ua_clerk_rollback','ua_locator_rollback'].includes(name))return rows();
      if(name==='ua_context_reset'){
        assert.equal(q.text,"SELECT set_config('ua.phase',$1,true),set_config('ua.person_id',$2,true),set_config('ua.person_ids',$3,true),set_config('ua.clerk_issuer',$4,true),set_config('ua.clerk_subject',$5,true),set_config('ua.telegram_id',$6,true)");
        assert.deepEqual(v,['deny','','[]','','','']);return rows();
      }
      if(name==='ua_context_phase'){assert.equal(q.text,"SELECT set_config('ua.phase',$1,true)");assert.equal(v.length,1);assert.ok(['deny','auth','domain','exchange'].includes(v[0]));return rows();}
      const db=d??this,s=db.state;
      if(name==='ua_clock'||name==='ua_clerk_clock')return rows([{now_ms:String(this.now)}]);
      if(['ua_people_context','ua_clerk_person_context','ua_telegram_identity_context','ua_telegram_identity_lock'].includes(name))return rows();
      if(name==='ua_identity_person')return rows(Object.entries(s.people).filter(([,p])=>p.telegramId===v[0]).map(([id])=>({id})));
      if(name==='ua_people_lock'){assert.equal(q.text,'SELECT id::text AS id FROM ua_private.lock_people($1::uuid[]) ORDER BY id');await this.before?.(s);this.before=undefined;return rows(v[0].filter(id=>s.people[id]).map(id=>({id})));}
      if(name==='ua_locate_access'){assert.equal(q.text,'SELECT person_id::text FROM ua_private.locate_student_access($1::text)');const a=s.access[v[0]],f=a&&s.families[a.familyId];return rows(f?[{person_id:this.locatorPerson??f.personId}]:[]);}
      if(name==='ua_http_person'||name==='ua_clerk_person'){const p=s.people[v[0]];return rows(p?[{telegram_id:p.telegramId===null?null:String(p.telegramId),enabled:p.enabled,roles:p.profile.roles,profile:structuredClone(p.profile)}]:[]);}
      const families=()=>Object.entries(s.families).filter(([,f])=>f.personId===v[0]);
      if(name==='ua_http_families'||name==='ua_clerk_families')return rows(families().map(([id,f])=>({id,person_id:f.personId,expires_at_ms:String(f.expiresAt),revoked_at_ms:f.revokedAt===null?null:String(f.revokedAt),logout_retain_until_ms:f.logoutRetainUntil===null?null:String(f.logoutRetainUntil),auth_provider:f.authProvider??null})));
      if(name==='ua_http_access'||name==='ua_clerk_access')return rows(Object.entries(s.access).filter(([,a])=>s.families[a.familyId]?.personId===v[0]).map(([digest,a])=>({digest,family_id:a.familyId,expires_at_ms:String(a.expiresAt),superseded:a.superseded})));
      if(name==='ua_http_refresh'||name==='ua_clerk_refresh')return rows(Object.entries(s.refresh).filter(([,a])=>s.families[a.familyId]?.personId===v[0]).map(([digest,a])=>({digest,family_id:a.familyId,consumed:a.consumed})));
      if(name==='ua_http_replays')return rows(Object.keys(s.consumedInitData).map(digest=>({digest})));
      if(name==='ua_http_grants')return rows(Object.entries(s.grants[v[0]]??{}).map(([assignment_id,g])=>({assignment_id,rostered:g.rostered,membership_epoch:String(g.membershipEpoch),grant_epoch:String(g.grantEpoch)})));
      if(name==='ua_http_assignments')return rows(Object.entries(s.assignments).filter(([id])=>s.grants[v[0]]?.[id]||Object.values(db.attempts).some(a=>a.body.personId===v[0]&&a.body.assignmentId===id)).map(([,a])=>({record:{...structuredClone(a),published:encodePublished(a.published)}})));
      if(name==='ua_http_series')return rows(Object.entries(db.series).filter(([k])=>k.startsWith(v[0]+'/')).map(([k,a])=>({demo_id:k.slice(v[0].length+1),id:a.id,current_attempt_id:a.currentAttemptId,generation:String(a.generation),normal_attempt_used:a.normalAttemptUsed,official_attempt_id:a.officialAttemptId,recovery_state:a.recoveryState,recovery_window:a.recovery})));
      if(name==='ua_http_attempt_ids')return rows(Object.keys(db.attempts).filter(id=>db.attempts[id].body.personId===v[0]).sort().map(id=>({id})));
      if(name==='ua_attempt_load'){const a=db.attempts[v[0]];return rows(a?.body.personId===v[1]?[structuredClone(a)]:[]);}
      if(name==='ua_answers_load')return rows(Object.values(db.answers[v[0]]??{}).map(a=>({...a,revision:String(a.revision),saved_at_ms:String(a.saved_at_ms),series_state_revision:String(a.series_state_revision)})));
      if(name==='ua_ordinary_load')return rows(db.results[v[0]]?[{exact_result:structuredClone(db.results[v[0]])}]:[]);
      if(name==='ua_http_receipts')return rows(Object.entries(db.receipts).filter(([k])=>k.startsWith(v[0]+'/')).map(([key,a])=>({key,payload:a.payload,attempt_id:a.attemptId})));
      if(name==='ua_http_bonuses'||name==='ua_http_cancellations')return rows();
      if(name==='ua_init_consume'){if(s.consumedInitData[v[0]])return rows();s.consumedInitData[v[0]]=true;return ack();}
      if(name==='ua_clerk_retire_person')return rows();
      if(name==='ua_http_family_merge'){const old=s.families[v[0]];s.families[v[0]]={personId:v[1],expiresAt:v[2],revokedAt:old?.revokedAt??v[3],logoutRetainUntil:old?.revokedAt!==null&&old?old.logoutRetainUntil:v[4],authProvider:v[5]};return ack();}
      if(name==='ua_http_access_merge'){s.access[v[0]]={familyId:v[1],expiresAt:v[2],superseded:v[3]};return ack();}
      if(name==='ua_http_refresh_merge'){s.refresh[v[0]]={familyId:v[1],consumed:v[2]};return ack();}
      if(name==='ua_attempt_insert'){if(db.attempts[v[0]])return rows();db.attempts[v[0]]={body:JSON.parse(v[6]),frozen_test:JSON.parse(v[7]),question_order:JSON.parse(v[8])};return ack();}
      if(name==='ua_http_series_merge'){db.series[v[0]+'/'+v[1]]={id:v[2],currentAttemptId:v[3],generation:v[4],stateRevision:v[5],normalAttemptUsed:v[6],officialAttemptId:v[7],recoveryState:v[8],recovery:JSON.parse(v[9])};return ack();}
      if(name==='ua_attempt_update'){const a=db.attempts[v[2]];if(!a||a.body.personId!==v[3]||a.body.generation!==v[4]||a.body.stateRevision!==v[5])return rows();a.body=JSON.parse(v[0]);return ack();}
      if(name==='ua_answer_cas'){const a=db.answers[v[0]]??={};const old=a[v[1]];if(old&&old.revision!==v[6])return rows();this.answerBranches.push(old?'UPDATE':'INSERT');a[v[1]]={question_id:v[1],selected_option_id:v[2],revision:v[3],saved_at_ms:v[4],series_state_revision:v[5]};return ack();}
      if(name==='ua_ordinary_insert'){if(db.results[v[0]])return rows();db.results[v[0]]=JSON.parse(v[1]);return ack();}
      if(name==='ua_series_update'){const a=db.series[v[3]+'/'+v[4]];if(!a||a.currentAttemptId!==v[2]||a.generation!==v[5])return rows();a.stateRevision=v[0];if(v[1])a.officialAttemptId=v[2];return ack();}
      if(name==='ua_http_receipt_insert'){if(db.receipts[v[1]])return rows();db.receipts[v[1]]={payload:v[2],attemptId:v[3]};return ack();}
      if(name==='ua_clerk_membership'){const p=s.people[v[0]];return rows([{active:p.profile.active_group_id!==null,epoch:'7',revision:'0',affinity_group_id:p.profile.active_group_id}]);}
      if(name==='ua_clerk_identities')return rows(db.identities.filter(i=>i.person_id===v[0]));
      if(name==='ua_clerk_bindings')return rows(Object.entries(db.bindings).filter(([id])=>s.families[id]?.personId===v[0]).map(([family_id,b])=>({family_id,person_id:v[0],issuer:b.issuer,subject:b.userId,sid:b.sessionId})));
      if(name==='ua_clerk_fences')return rows(db.fences.filter(f=>f.person_id===v[0]));
      if(name==='ua_clerk_replays')return rows();
      throw Error('UNHANDLED_OFFLINE_STATEMENT:'+name);
    }};
  }
}
