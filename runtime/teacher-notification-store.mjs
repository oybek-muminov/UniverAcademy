import { randomUUID } from 'node:crypto';

// transaction() uses the existing restricted Telegram delivery login.
export function teacherNotifications(transaction) {
  async function changeClaim(q, sql, values) {
    const rows = await q(sql + ' RETURNING id', values);
    if (rows.length !== 1) throw Error('TEACHER_NOTIFICATION_CLAIM_LOST');
  }

  return {
    async claimSend() {
      return transaction(async q => {
        const claim = randomUUID();
        const [row] = await q(`WITH candidate AS (
          SELECT n.id, p.telegram_id, EXISTS (
            SELECT FROM ua_private.teacher_subject_approvals subject
            WHERE subject.person_id = p.id AND subject.subject_id = 'physics'
              AND subject.approved AND subject.revoked_at_ms IS NULL
          ) AS physics
          FROM ua_cabinet.teacher_notifications n
          JOIN ua_private.people p ON p.id = n.person_id
          JOIN ua_private.staff_access staff ON staff.person_id = p.id AND staff.approved
          WHERE n.state IN ('queued','retry') AND n.available_at <= now()
            AND p.enabled AND 'teacher' = ANY(p.roles) AND p.telegram_id BETWEEN 1 AND 9007199254740991
            AND EXISTS (SELECT FROM ua_private.teacher_subject_approvals s
              WHERE s.person_id=p.id AND s.approved AND s.revoked_at_ms IS NULL)
          ORDER BY n.available_at, n.id LIMIT 1 FOR UPDATE OF n SKIP LOCKED
        )
        UPDATE ua_cabinet.teacher_notifications n
        SET state='sending', claim_id=$1, claimed_at=clock_timestamp(), chat_id=c.telegram_id
        FROM candidate c WHERE c.id=n.id RETURNING n.chat_id, c.physics`, [claim]);
        return row ? { claim, chatId:Number(row.chat_id), physics:row.physics } : null;
      });
    },

    async finishSend(claim, outcome) {
      return transaction(async q => {
        if (outcome.status === 'sent') {
          // Use Telegram's message timestamp whenever supplied, even if receipt processing is delayed.
          await changeClaim(q, `UPDATE ua_cabinet.teacher_notifications
            SET state='sent', message_id=$2, sent_at=COALESCE(to_timestamp($3),now()),
              delete_after=COALESCE(to_timestamp($3),now())+interval '24 hours',
              available_at=COALESCE(to_timestamp($3),now())+interval '24 hours',
              delete_until=COALESCE(to_timestamp($3),now())+interval '48 hours',
              claim_id=NULL, claimed_at=NULL
            WHERE claim_id=$1 AND state='sending'`, [claim, outcome.messageId, outcome.date]);
        } else {
          await changeClaim(q, `UPDATE ua_cabinet.teacher_notifications
            SET state=$2, available_at=now()+($3::bigint*interval '1 millisecond'),
              blocked_at=CASE WHEN $2='blocked' THEN now() END,
              chat_id=NULL, claim_id=NULL, claimed_at=NULL
            WHERE claim_id=$1 AND state='sending'`, [claim, outcome.status, outcome.delay ?? 0]);
        }
      });
    },

    async claimDelete() {
      return transaction(async q => {
        // Never repeat an unacknowledged send. Deletion of a known message is safe to retry.
        await q(`WITH stale AS (
          SELECT id FROM ua_cabinet.teacher_notifications WHERE
            (state='sending' AND claimed_at < now()-interval '1 hour') OR
            (state IN ('sent','delete_retry','deleting') AND delete_until <= now())
          LIMIT 20 FOR UPDATE SKIP LOCKED
        ) UPDATE ua_cabinet.teacher_notifications n
          SET state=CASE WHEN n.state='sending' THEN 'unconfirmed' ELSE 'expired' END,
            claim_id=NULL, claimed_at=NULL, chat_id=NULL, message_id=NULL, sent_at=NULL,
            delete_after=NULL, delete_until=NULL
          FROM stale WHERE n.id=stale.id`);
        const claim = randomUUID();
        const [row] = await q(`WITH candidate AS (
          SELECT id FROM ua_cabinet.teacher_notifications
          WHERE delete_after <= now() AND delete_until > now() AND (
            (state IN ('sent','delete_retry') AND available_at <= now())
            OR (state='deleting' AND claimed_at < now()-interval '2 minutes'))
          ORDER BY delete_after, id LIMIT 1 FOR UPDATE SKIP LOCKED
        ) UPDATE ua_cabinet.teacher_notifications n
          SET state='deleting', claim_id=$1, claimed_at=clock_timestamp()
          FROM candidate c WHERE n.id=c.id RETURNING n.chat_id,n.message_id`, [claim]);
        return row ? { claim, chatId:Number(row.chat_id), messageId:Number(row.message_id) } : null;
      });
    },

    async finishDelete(claim, outcome) {
      return transaction(async q => {
        if (outcome.status === 'deleted') {
          await changeClaim(q, `UPDATE ua_cabinet.teacher_notifications
            SET state='deleted', claim_id=NULL, claimed_at=NULL, chat_id=NULL, message_id=NULL,
              sent_at=NULL, delete_after=NULL, delete_until=NULL
            WHERE claim_id=$1 AND state='deleting'`, [claim]);
        } else {
          await changeClaim(q, `UPDATE ua_cabinet.teacher_notifications
            SET state='delete_retry', claim_id=NULL, claimed_at=NULL,
              available_at=LEAST(delete_until,now()+($2::bigint*interval '1 millisecond'))
            WHERE claim_id=$1 AND state='deleting'`, [claim, outcome.delay]);
        }
      });
    }
  };
}
