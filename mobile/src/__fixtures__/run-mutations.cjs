/** Focused security mutations are run only in a disposable source copy. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const mobile=path.resolve(__dirname,'../..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'lb-mutations-'));
const changes=[
 ['scope revocation omitted','src/auth/AuthContext.tsx','for (const revoke of revokers.current) revoke();','/* mutation: no revocation */'],
 ['logout intent omitted','src/auth/AuthContext.tsx','try { markLogoutPending(); } catch { /* Cleanup still attempts both native removals. */ }','/* mutation: no durable intent */'],
 ['restore ignores pending cleanup','src/auth/AuthContext.tsx','if (cleanupRequired.current || logoutPending()) {','if (false) {'],
 ['cleanup reports success despite retained credentials','src/auth/logoutIntent.ts','if (removed.some(result => result.status === "rejected")) throw new Error("Credential deletion failed");','/* mutation: accept failed deletion */'],
 ['driver confirmation bypassed','src/shift/localShift.ts','if (confirmation.confirmedByDriver !== true) return Promise.resolve("refused" as const);','/* mutation: no driver confirmation */'],
 ['candidate ownership bypassed','src/shift/localShift.ts','if (day === null || day.ownerUserId !== scope.userId) return null;','if (day === null) return null;'],
 ['offered bytes not rechecked','src/shift/localShift.ts','candidate.bytes !== offer.bytes || ',''],
 ['existing destination overwritten','src/shift/localShift.ts','if (target === null || target.exists) return null;','if (target === null) return null;'],
];
try {
 for(const name of ['src','app','restart-tests','package.json','tsconfig.json','babel.config.js','jest.config.js','jest.setup.js']) if(fs.existsSync(path.join(mobile,name)))fs.cpSync(path.join(mobile,name),path.join(scratch,name),{recursive:true});
 fs.symlinkSync(path.join(mobile,'node_modules'),path.join(scratch,'node_modules'),'dir');
 let killed=0;
 for(const [name,file,needle,replacement] of changes){
  const target=path.join(scratch,file),original=fs.readFileSync(target,'utf8');
  if(!original.includes(needle))throw new Error('Mutation anchor missing: '+name);
  let mutated=original.replace(needle,replacement);
  if(name.startsWith('cleanup reports'))mutated=mutated.replace('if (token !== null || preferencePresent) throw new Error("Credentials remain");','/* mutation: no read-back */');
  if(name.startsWith('existing destination'))mutated=mutated.replace('if (candidate.target.exists) return Promise.resolve("refused" as const);','/* mutation: overwrite live */').replace('stage.moveSync(candidate.target, { overwrite: false });','stage.moveSync(candidate.target, { overwrite: true });');
  fs.writeFileSync(target,mutated);
  const result=spawnSync(process.execPath,[path.join(mobile,'node_modules/jest/bin/jest.js'),'--runInBand','--ci','src/__tests__/logoutFailure.test.tsx','src/__tests__/interruptedRecovery.test.ts'],{cwd:scratch,encoding:'utf8'});
  fs.writeFileSync(target,original);
  if(result.status===0)throw new Error('SURVIVED: '+name);
  if(!/●/.test(result.stderr)||/SyntaxError|Cannot find module|Test suite failed to run/.test(result.stderr))throw new Error('Invalid mutation run: '+name+'\n'+result.stderr);
  killed++;console.log('KILLED: '+name);
 }
 console.log('PASS: '+killed+'/'+changes.length+' focused security mutations killed');
}finally{fs.rmSync(scratch,{recursive:true,force:true})}
