// Only the authenticated private bot/dispatcher can use this separate DB service role.
import {randomUUID} from 'node:crypto';

export function createStagingInviteDeliveryStore({pool}){
  async function transaction(fn){
    const client=await pool.connect();
    let discard=false,committing=false;
    const q=async(text,values=[])=>(await client.query({text,values})).rows;
    try{
      await q('BEGIN');await q('SET LOCAL ROLE ua_cabinet_delivery');
      const value=await fn(q);committing=true;await q('COMMIT');return value;
    }catch(error){
      if(committing)discard=true;
      else try{await q('ROLLBACK');}catch{discard=true;}
      throw error;
    }finally{client.release(discard);}
  }
  return {
    recordPrivateStart({telegramUserId}){
      if(!Number.isSafeInteger(telegramUserId)||telegramUserId<=0)throw Error('INVALID_TELEGRAM_ID');
      return transaction(async q=>{
        // A verified prior /start is not proof of enrollment. The worker joins the current
        // enabled, linked person against this same Telegram ID again at send time.
        await q('INSERT INTO ua_cabinet.private_starts(telegram_id) VALUES($1) ON CONFLICT DO NOTHING',[telegramUserId]);
      });
    },
    claimInviteDelivery(){
      return transaction(async q=>{
        const claim=randomUUID();
        const [row]=await q(`WITH next AS (
          SELECT d.id FROM ua_cabinet.invite_delivery d JOIN ua_cabinet.invites i ON i.digest=d.invite_digest
          JOIN ua_private.people p ON p.id=i.recipient_id AND p.enabled AND 'student'=ANY(p.roles) AND p.telegram_id=d.telegram_id
          JOIN ua_cabinet.private_starts c ON c.telegram_id=p.telegram_id JOIN ua_private.groups g ON g.id=i.group_id AND g.status='active'
          JOIN ua_cabinet.group_requests gr ON gr.active_group_id=g.id AND gr.teacher_id=i.created_by
          JOIN ua_private.people t ON t.id=i.created_by AND t.enabled AND 'teacher'=ANY(t.roles)
          JOIN ua_private.staff_access a ON a.person_id=t.id AND a.approved
          JOIN ua_private.teacher_subject_approvals s ON s.person_id=t.id AND s.subject_id=gr.subject_id AND s.approved AND s.revoked_at_ms IS NULL
          JOIN ua_private.staff_group_scope sc ON sc.person_id=t.id AND sc.group_id=g.id AND sc.revoked_at_ms IS NULL
          WHERE d.status IN ('queued','retry') AND d.available_at<=clock_timestamp() AND i.expires_at>clock_timestamp()
          ORDER BY d.available_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED)
          UPDATE ua_cabinet.invite_delivery d SET status='claimed',claim_id=$1,claimed_at=clock_timestamp()
          FROM next WHERE d.id=next.id RETURNING d.claim_id id,d.token,d.telegram_id`,[claim]);
        return row?{id:row.id,token:row.token,telegramUserId:Number(row.telegram_id)}:null;
      });
    },
    finishInviteDelivery(id,{status,retryAfterMs=0}){
      if(!['sent','unconfirmed','rejected','retry'].includes(status)||!Number.isSafeInteger(retryAfterMs)||retryAfterMs<0)throw Error('INVALID_DELIVERY_OUTCOME');
      return transaction(async q=>{
        const rows=await q(`UPDATE ua_cabinet.invite_delivery d SET status=CASE WHEN $2='retry' AND
          clock_timestamp()+($3::bigint*interval '1 millisecond')>=i.expires_at THEN 'rejected' ELSE $2 END,
          available_at=clock_timestamp()+($3::bigint*interval '1 millisecond')
          FROM ua_cabinet.invites i WHERE d.invite_digest=i.digest AND d.claim_id=$1 AND d.status='claimed' RETURNING d.id`,[id,status,Math.min(retryAfterMs,86400000)]);
        if(!rows.length)throw Error('DELIVERY_CLAIM_LOST');
      });
    }
  };
}
