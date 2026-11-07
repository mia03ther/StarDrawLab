const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const result=spawnSync(process.execPath,['--test','--test-concurrency=2',...['bootstrap-local-database.test.mjs','localIdentity.test.mjs','local-provider.test.mjs'].map(f=>path.join(__dirname,f))],{env:{...process.env,STARDRAW_PROJECT_ROOT:root},stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;process.exitCode=result.status||0;
