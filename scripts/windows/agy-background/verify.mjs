// Run on Windows after build: node verify.mjs <build-directory> <private-test-directory>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
if (process.platform !== 'win32') throw Error('This check requires Windows.');
const [build, scratch] = process.argv.slice(2);
if (!build || !scratch || !path.isAbsolute(scratch)) throw Error('Supply a build directory and an absolute private test directory.');
await fs.mkdir(scratch, { recursive: true });
const test = await fs.mkdtemp(path.join(scratch, 'agy-launcher-'));
try {
  for (const name of ['agy-background.exe', 'agy-background.dll', 'agy-background.runtimeconfig.json', 'agy-background.deps.json'])
    await fs.copyFile(path.join(build, name), path.join(test, name));
  await fs.writeFile(path.join(test, 'agy-path.txt'), process.execPath);
  const script = path.join(test, 'child.cjs');
  await fs.writeFile(script, `
const {spawn}=require('node:child_process');
if(process.argv[2]==='lifetime') {
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
 console.log(JSON.stringify({pid:process.pid,child:child.pid}));setInterval(()=>{},1000);
} else {
 let input=''; process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 console.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),input}));
 console.error('stderr-sentinel');process.exitCode=23;
 });
}
`);
  const values = ['', '中文 space', 'quote"inside', 'C:\\ends with slash\\', '  keep spaces  '];
  const launch = args => spawn(path.join(test, 'agy-background.exe'), [script, ...args], { cwd:test, windowsHide:true });
  const child = launch(values); let stdout='', stderr='';
  child.stdout.on('data', c=>stdout+=c); child.stderr.on('data', c=>stderr+=c);
  child.stdin.end('stdin-sentinel\n');
  const [code] = await once(child, 'close');
  assert.equal(code,23,stderr); const result=JSON.parse(stdout);
  assert.deepEqual(result.argv,values); assert.equal(result.cwd,test); assert.equal(result.input,'stdin-sentinel\n');
  assert.equal(stderr.trim(),'stderr-sentinel');
  const lifetime=launch(['lifetime']);
  const [chunk]=await once(lifetime.stdout,'data');
  const ids=JSON.parse(chunk.toString());const closed=once(lifetime,'close');lifetime.kill();await closed;
  for(let attempt=0;attempt<30;attempt++) {
    const alive=[ids.pid,ids.child].filter(pid=>{try{process.kill(pid,0);return true;}catch{return false;}});
    if(!alive.length)break;
    if(attempt===29)throw Error('Cancellation left a child process running');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  console.log(JSON.stringify({stdio:true,arguments:true,cwd:true,exitCode:true,cancellationTree:true}));
} finally { await fs.rm(test,{recursive:true,force:true}); }
