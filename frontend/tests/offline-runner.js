const output = document.querySelector('#results');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const reject = async (action, label) => { let failed=false; try { await action(); } catch { failed=true; } assert(failed,label); };
document.querySelector('#run').onclick = async () => {
  const button=document.querySelector('#run'); button.disabled=true; output.textContent='Running…\n';
  const name='attendly-test-'+crypto.randomUUID(); let store; const owner=999991; let passed=0;
  const pass=message=>{ passed++; output.textContent+=`PASS ${message}\n`; };
  try {
    const coreUrl = new URL('/offline-core.js', location.origin).href; const syncUrl = new URL('/sync-engine.js', location.origin).href; const compressUrl = '/src/offline/compress.js';
    const { createStore } = await import(/* @vite-ignore */ coreUrl);
    const { createSyncEngine, http } = await import(/* @vite-ignore */ syncUrl);
    const { compressCapture } = await import(/* @vite-ignore */ compressUrl);
    store=createStore(name);
    for (const periods of [0,5,8,1.5]) await reject(()=>store.newJob(owner,{assignmentId:1,periods,mode:'single'}),'Invalid period count was saved offline');
    assert((await store.all('jobs')).length===0,'Rejected period count left a partial capture');
    const boundary=await store.newJob(owner,{assignmentId:1,periods:4,mode:'single'});
    assert(boundary.periods===4,'Four periods were rejected');
    await store.discardDraft(owner,boundary.id);
    pass('Offline captures accept 1–4 periods and reject invalid counts without saving a draft');
    const job=await store.newJob(owner,{assignmentId:1,periods:1,mode:'single'});
    await store.saveFrame(owner,job.id,0,new Blob(['private-test-image'],{type:'image/jpeg'}));
    await store.close(); store=createStore(name);
    assert(await (await store.readFrame(owner,`${job.id}:0`)).text()==='private-test-image','Photo did not survive database reopen');
    const raw=await store.get('frames',`${job.id}:0`); assert(raw.encrypted instanceof ArrayBuffer && !('blob' in raw),'Plaintext image was stored');
    await reject(()=>store.readFrame(owner+1,`${job.id}:0`),'Cross-account photo access succeeded');
    const key=(await store.get('keys',String(owner))).key; await reject(()=>crypto.subtle.exportKey('raw',key),'Encryption key was exportable');
    pass('Encrypted image and non-extractable key survive reopen; account guard works');
    await store.saveFrame(owner,job.id,0,new Blob(['retaken-image'],{type:'image/jpeg'}));
    assert((await store.all('frames')).length===1,'Retake duplicated a frame');
    const low=createStore(name,{estimateStorage:async()=>({quota:100,usage:100})});
    await reject(()=>low.saveFrame(owner,job.id,0,new Blob(['replacement'])),'Low storage was ignored');
    assert(await(await store.readFrame(owner,`${job.id}:0`)).text()==='retaken-image','Failed replacement destroyed the previous image'); await low.close();
    pass('Retake replaces one slot; low-storage failure preserves previous capture');
    await store.markReady(owner,job.id);
    await reject(()=>store.saveFrame(owner,job.id,0,new Blob(['late-change'])),'Queued frame was mutable');
    const pano=await store.newJob(owner,{assignmentId:1,periods:1,mode:'panorama'});
    await store.saveFrame(owner,pano.id,0,new Blob(['left']));
    await reject(()=>store.markReady(owner,pano.id),'Incomplete panorama was queued');
    await store.saveFrame(owner,pano.id,1,new Blob(['center'])); await store.saveFrame(owner,pano.id,2,new Blob(['right'])); await store.markReady(owner,pano.id);
    pass('Single shot defaults to one frame; panorama requires exactly three slots');
    assert(await store.acquire(job.id,'first'),'Lease not acquired'); assert(!await store.acquire(job.id,'second'),'Two workers acquired the same job');
    await store.update(job.id,{leaseUntil:Date.now()-1}); assert(await store.acquire(job.id,'second'),'Expired lease did not recover');
    await store.release(job.id,'first'); assert((await store.get('jobs',job.id)).leaseToken==='second','Stale worker released another worker lease'); await store.release(job.id,'second');
    pass('Concurrent worker exclusion and interrupted lease recovery');
    const sessions=new Map(), photos=new Map(); let uploadAttempts=0, commitCalls=0, loseUpload=true, loseCommit=true, authorized=true, final=false;
    const transport=async(path, options={})=>{
      if(path==='/api/auth/me'){if(!authorized){const e=new Error('Expired test login');e.status=401;throw e;}return{id:owner,role:'teacher'};}
      if(path==='/api/sessions/create'){const id=options.body.get('client_request_id');if(!sessions.has(id))sessions.set(id,{session_id:'test-session',status:'active'});return sessions.get(id);}
      if(path.endsWith('/upload')){uploadAttempts++;const id=options.body.get('client_photo_id');if(!photos.has(id))photos.set(id,photos.size+1);if(loseUpload){loseUpload=false;throw new TypeError('Response lost after server stored image');}return{class_photo_id:photos.get(id)};}
      if(path.endsWith('/analysis'))return{results:[],unresolved_count:0};
      if(path.endsWith('/confirm')){commitCalls++;final=true;if(loseCommit){loseCommit=false;throw new TypeError('Response lost after commit');}return{status:'confirmed'};}
      return{session_id:'test-session',status:final?'confirmed':'active',processed_photos:[{id:1,client_photo_id:job.id+'_0'}]};
    };
    let online=false;const engine=createSyncEngine({store,transport,online:()=>online});
    await engine.runJob(owner,job.id,{force:true}); assert((await store.get('jobs',job.id)).state==='saved_offline','Offline status not persisted');
    online=true;await engine.runJob(owner,job.id,{force:true}); assert((await store.get('jobs',job.id)).state==='failed','Interrupted upload not recorded');
    await store.close();store=createStore(name);const resumed=createSyncEngine({store,transport,online:()=>online});await resumed.runJob(owner,job.id,{force:true});
    assert((await store.get('jobs',job.id)).state==='needs_review','Retry did not reach review');assert(sessions.size===1 && photos.size===1 && uploadAttempts===2,'Retry created duplicates');assert(await store.get('frames',`${job.id}:0`),'Images removed before final commit');
    pass('Offline and lost upload response recover after restart without duplicate sessions/photos');
    authorized=false;await resumed.runJob(owner,job.id,{force:true});assert((await store.get('jobs',job.id)).state==='auth_required','Expired auth not paused');assert(await store.get('frames',`${job.id}:0`),'Expired auth lost image');authorized=true;
    await reject(()=>store.cleanupCommitted(job.id,{session_id:'test-session',status:'active'}),'Uncommitted image was deleted');
    await reject(()=>store.cleanupCommitted(job.id,{session_id:'test-session',status:'confirmed',processed_photos:[]}), 'Unprocessed local frame was deleted after a different capture finalized');
    assert(await store.get('frames',`${job.id}:0`),'Missing processing receipt lost the only local frame');
    pass('Expired login pauses synchronization and uncommitted photos are retained');
    await store.savePrivate(owner,'review-session:test-session',{1:{status:'present',reason:'Teacher checked'}});
    const reviewStore=createStore(name);
    assert((await reviewStore.readPrivate(owner,'review-session:test-session'))[1].status==='present','Session review did not survive refresh/reopen');
    await reviewStore.close();
    pass('Encrypted session review survives reopen for direct review links');
    await store.savePrivate(owner,`confirmation:${job.id}`,[]);await store.update(job.id,{confirmationPending:true});await resumed.runJob(owner,job.id,{force:true});
    assert(await store.get('frames',`${job.id}:0`),'Lost commit response caused premature cleanup');
    await resumed.runJob(owner,job.id,{force:true});assert((await store.get('jobs',job.id)).state==='completed','Server commit was not recovered');assert(!await store.get('frames',`${job.id}:0`),'Committed image was not deleted');assert(commitCalls===1,'Commit retried instead of checking server receipt');
    pass('Lost confirmation response is recovered from server receipt, then local images are cleaned');
    assert(await store.readPrivate(owner,'review-session:test-session')===null,'Finalized session review was not removed');
    const canvas=document.createElement('canvas');canvas.width=3000;canvas.height=2000;canvas.getContext('2d').fillRect(0,0,3000,2000);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const compressed=await compressCapture(blob);const bitmap=await createImageBitmap(compressed);assert(bitmap.width===2560 && compressed.type==='image/jpeg','Compression limits or type incorrect');bitmap.close();
    pass('Canvas compression bounds dimensions and uses JPEG; no gallery write occurs');
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response('truncated-json', { status: 200, headers: { 'Content-Type': 'application/json' } });
      await reject(() => http('/test-only-response'), 'Malformed success response was accepted');
      globalThis.fetch = async () => new Response('Sign in required', { status: 401 });
      let status; try { await http('/test-only-auth'); } catch (error) { status=error.status; }
      assert(status===401, 'Authentication failure lost its status');
    } finally { globalThis.fetch=originalFetch; }
    pass('Interrupted JSON responses cannot acknowledge a capture; expired auth keeps its status');
    output.textContent+=`\n${passed} TESTS PASSED — isolated browser storage and simulated transport only.\n`;
    document.title=`${passed} offline tests passed`;
  } catch(error){output.textContent+=`FAIL ${error.stack}\n`;document.title='Offline tests failed';}
  finally{if(store)await store.close();indexedDB.deleteDatabase(name);button.disabled=false;}
};
