import { randomBytes, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { issueProofs, proofHash } from '../../supabase/functions/univeracademy-api/student-state.ts';
import { addProfile } from './cluster.mjs';

export const issuer = 'https://clerk.stage-classroom.example.com';
export const party = 'https://teacher.stage-classroom.example.com';

export async function testClerk() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture-clerk-signer', alg:'RS256', use:'sig' };
  const sessions = new Map();
  const verifier = { issuer, authorizedParties:[party], audience:{kind:'clerk_default_no_audience'},
    trustedKeys:createLocalJWKSet({keys:[jwk]}), now:Date.now };
  async function sign(subject,claims={}) {
    const now = Math.floor(Date.now()/1000);
    const sid = 'sess_' + subject.slice(5);
    const token = await new SignJWT({iss:issuer, sub:subject, sid, azp:party, iat:now-1, nbf:now-1,
      exp:now+600, jti:randomUUID(), v:2, ...claims})
      .setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(privateKey);
    sessions.set(sid,{issuer,userId:subject,sessionId:sid,status:'active',accountEnabled:true,expiresAt:(now+600)*1000});
    return token;
  }
  return { verifier, sign, publicConfiguration:()=>({jwk,sessions:[...sessions]}), liveness:async ({sessionId})=>sessions.get(sessionId) };
}

export async function provisionStaff(admin, name, role) {
  const id=await addProfile(admin,{role,name});
  const subject='user_'+randomBytes(10).toString('hex');
  await admin.query(`INSERT INTO ua_private.staff_identities(issuer,provider_subject,person_id)
    VALUES ($1,$2,$3)`,[issuer,subject,id]);
  await admin.query(`INSERT INTO ua_private.clerk_identities(issuer,subject,person_id,enabled)
    VALUES ($1,$2,$3,true)`,[issuer,subject,id]);
  await admin.query(`INSERT INTO ua_private.staff_access(person_id,approved,manage_roster,manage_content,all_groups,all_subjects)
    VALUES ($1,true,$2,false,$2,$2)`,[id,role==='admin']);
  if (role==='teacher') {
    await admin.query(`INSERT INTO ua_private.teacher_subject_approvals(person_id,subject_id,approved)
      VALUES ($1,'physics',true)`,[id]);
    await admin.query(`INSERT INTO ua_private.staff_subject_scope(person_id,subject_id)
      VALUES ($1,'physics')`,[id]);
  }
  return {id,subject};
}

export async function provisionStudent(admin,name,cabinetId,telegramId,{clerk}={}) {
  const id=await addProfile(admin,{name,role:'student',cabinetId,telegramId});
  const familyId=randomUUID(),now=Date.now(),end=now+3_600_000;
  const proofState={families:{[familyId]:{expiresAt:end}},access:{},refresh:{}};
  const proof=await issueProofs(proofState,familyId,now,{accessTtlMs:1_800_000});
  const token=proof.accessToken,digest=await proofHash(token);
  let subject, sessionId;
  await admin.query('BEGIN');
  try {
    if(clerk) {
      subject='user_'+randomBytes(10).toString('hex');
      sessionId='sess_'+subject.slice(5);
      await clerk.sign(subject);
      await admin.query('INSERT INTO ua_private.clerk_identities(issuer,subject,person_id,enabled) VALUES ($1,$2,$3,true)',[issuer,subject,id]);
      await admin.query('INSERT INTO ua_private.clerk_student_sessions(issuer,subject,sid,person_id) VALUES ($1,$2,$3,$4)',[issuer,subject,sessionId,id]);
    }
    await admin.query(`INSERT INTO ua_private.student_families(id,person_id,expires_at_ms,auth_provider)
      VALUES ($1,$2,$3,$4)`,[familyId,id,end,clerk?'clerk':'telegram']);
    if(clerk) await admin.query(`INSERT INTO ua_private.clerk_family_bindings(family_id,issuer,subject,sid,person_id)
      VALUES ($1,$2,$3,$4,$5)`,[familyId,issuer,subject,sessionId,id]);
    await admin.query(`INSERT INTO ua_private.student_access(digest,family_id,expires_at_ms,superseded)
      VALUES ($1,$2,$3,false)`,[digest,familyId,proof.expiresAt]);
    await admin.query('INSERT INTO ua_private.student_refresh(digest,family_id,consumed) VALUES ($1,$2,false)',
      [await proofHash(proof.refreshToken),familyId]);
    await admin.query('COMMIT');
  } catch(error) { await admin.query('ROLLBACK'); throw error; }
  return {id,token,familyId,cabinetId,telegramId,subject,sessionId};
}
