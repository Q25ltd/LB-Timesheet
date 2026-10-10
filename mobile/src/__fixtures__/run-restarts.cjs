const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const cwd=path.resolve(__dirname,'../..');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lb-restarts-'));
try {
  for(const phase of ['logout-seed','logout-blocked','logout-retry','write-seed','write-not-now','write-confirm','write-read']) {
    const result=spawnSync(process.execPath,[path.join(cwd,'node_modules/jest/bin/jest.js'),'--config','jest.restart.config.js','--runInBand','--ci'],{cwd,stdio:'inherit',env:{...process.env,LB_RESTART_ROOT:root,LB_RESTART_PHASE:phase,LB_FAIL_DELETE:phase==='logout-seed'||phase==='logout-blocked'?'yes':'no'}});
    if(result.status!==0)throw new Error('Restart phase failed: '+phase);
  }
  console.log('PASS: seven separate processes shared only disposable disk and synthetic keychain state');
} finally {fs.rmSync(root,{recursive:true,force:true})}
