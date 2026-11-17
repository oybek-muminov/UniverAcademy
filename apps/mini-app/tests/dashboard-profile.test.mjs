import test from 'node:test';
import assert from 'node:assert/strict';
import { StudentFlow } from '../src/flow.ts';
import { saveDashboardProfile } from '../src/dashboard-profile.ts';
const student = { person: 'p1', firstName: 'Old', lastName: 'Name', displayId: '1', registrationComplete: true };
function setup(register) {
 const flow = new StudentFlow({ register });
 flow.patch({ student, screen: 'exams' });
 return flow;
}
test('dashboard saves trimmed server-authoritative profile without navigating or fetching exams', async () => {
 const flow = setup(async (firstName, lastName) => ({...student, firstName, lastName}));
 assert.equal(await saveDashboardProfile(flow, 'p1', ' New ', ' Name '), true);
 assert.equal(flow.state.student.firstName, 'New');
 assert.equal(flow.state.screen, 'exams');
});
test('invalid and wrong-identity edits never send a request', async () => {
 let calls = 0;
 const flow = setup(async () => { calls++; return student; });
 for (const [p,f,l] of [['p2','A','B'],['p1',' ','B'],['p1','x'.repeat(101),'B']]) assert.equal(await saveDashboardProfile(flow,p,f,l),false);
 assert.equal(calls,0);
});
test('failed save retains old name and reports failure, never success', async () => {
 const flow=setup(async()=>{throw Error('synthetic');});
 assert.equal(await saveDashboardProfile(flow,'p1','A','B'),false);
 assert.equal(flow.state.student.firstName,'Old');
 assert.ok(flow.state.failure);
});
test('identity switch during pending save cannot replace next user', async () => {
 let resolve;
 const flow=setup(()=>new Promise(r=>{resolve=r;}));
 const pending=saveDashboardProfile(flow,'p1','A','B');
 const next={...student,person:'p2'};
 flow.patch({student:next});
 resolve({...student,firstName:'A'});
 assert.equal(await pending,false);
 assert.equal(flow.state.student,next);
});
test('wrong returned identity is not adopted',async()=>{
 const flow=setup(async()=>({...student,person:'p2'}));
 assert.equal(await saveDashboardProfile(flow,'p1','A','B'),false);
 assert.equal(flow.state.student,student);
});
test('parallel save cannot submit a duplicate request',async()=>{
 let resolve, calls=0;
 const flow=setup(()=>{calls++;return new Promise(r=>resolve=r);});
 const one=saveDashboardProfile(flow,'p1','A','B');
 assert.equal(await saveDashboardProfile(flow,'p1','C','D'),false);
 resolve(student); await one; assert.equal(calls,1);
});
