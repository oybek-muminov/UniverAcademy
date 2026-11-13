// Extends the existing file-backed statement executor DOUBLE. Still no SQL
// parser, actual row locks, isolation, FK/unique enforcement or RLS proof.
import {httpExecutor} from "../persistent-http/executor.mjs";
export function firstTestExecutor(path) {
  const pool=httpExecutor(path), previous=pool.extension;
  // Driver results are detached decoded rows, not references to storage's draft.
  const result=(rows=[])=>structuredClone({rows,rowCount:rows.length}), ack=()=>result([{}]);
  pool.extension=async(statement,d)=>{
    const {name,values:v}=statement;
    if(name==="ua_first_group_lock"||name==="ua_first_version_lock"){
      if(pool.beforeResourceLock){const hook=pool.beforeResourceLock;pool.beforeResourceLock=null;await hook(d);}
      if(name==="ua_first_group_lock"){const g=d.groups[v[0]];return result(g?[{...g,revision:String(g.revision)}]:[]);}
      const row=d.versions[v[0]],demo=row&&d.demos[row.demo_id];
      return result(row&&demo?[{...row,revision:String(row.revision),subject_id:demo.subjectId,title:demo.title}]:[]);
    }
    if(name==="ua_first_questions")return result(Object.entries(d.questions[v[0]]??{}).sort((a,b)=>a[1].position-b[1].position).map(([id,record])=>({id,record})));
    if(name==="ua_first_membership"){const m=d.memberships[v[0]];return result(m?[{...m,revision:String(m.revision),epoch:String(m.epoch)}]:[]);}
    if(name==="ua_first_grants")return result(Object.entries(d.grants[v[0]]??{}).map(([assignment_id,g])=>({assignment_id,rostered:g.rostered,grant_epoch:String(g.grantEpoch)})));
    if(name==="ua_first_assignments")return result(Object.values(d.assignments).filter(a=>a.admission.groupId===v[0]&&a.published.demoId===v[1]).map(record=>({record})));
    if(name==="ua_first_receipt"){const row=d.staffReceipts[v[1]];return result(row?.actor===v[0]?[row]:[]);}
    if(name==="ua_first_version_write"){
      const old=d.versions[v[0]];if(!old||old.revision!==v[5]||old.status!=="draft")return result();
      Object.assign(old,{wire:JSON.parse(v[1]),revision:v[2],status:v[3],published_snapshot:JSON.parse(v[4])});return ack();
    }
    if(name==="ua_first_question_write"){(d.questions[v[0]]??={})[v[1]]=JSON.parse(v[3]);return ack();}
    if(name==="ua_first_group_write"){
      const g=d.groups[v[0]];if(!g||g.revision!==v[2]||g.status!=="active")return result();g.revision=v[1];return ack();
    }
    if(name==="ua_first_membership_write"){
      const m=d.memberships[v[0]];if(!m||m.revision!==v[4]||m.epoch!==v[5]||m.affinity_group_id!==null||m.active)return result();
      Object.assign(m,{affinity_group_id:v[1],active:true,revision:v[2],epoch:v[3]});return ack();
    }
    if(name==="ua_first_person_group_write"){
      const p=d.people[v[0]];if(!p||p.profile.active_group_id!==null)return result();p.profile.active_group_id=v[1];return ack();
    }
    if(name==="ua_first_assignment_write"){
      if(d.assignments[v[0]]||Object.values(d.assignments).some(a=>a.admission.groupId===v[1]&&a.published.demoId===v[2]))return result();
      d.assignments[v[0]]=JSON.parse(v[4]);return ack();
    }
    if(name==="ua_first_grant_write"){
      const grants=d.grants[v[0]]??={};if(grants[v[1]])return result();grants[v[1]]={rostered:true,grantEpoch:v[2]};return ack();
    }
    if(name==="ua_first_receipt_write"){
      if(d.staffReceipts[v[1]])return result();d.staffReceipts[v[1]]={actor:v[0],payload:v[2],response:JSON.parse(v[3])};return ack();
    }
    if(name==="ua_first_audit_write"){
      if(d.staffAudit.some(a=>a.command_key===v[0]))return result();
      d.staffAudit.push({command_key:v[0],actorId:v[1],action:v[2],targetId:v[3],revision:v[4],at:v[5]});return ack();
    }
    const handled=await previous(statement,d);return handled===undefined?undefined:structuredClone(handled);
  };
  return pool;
}
