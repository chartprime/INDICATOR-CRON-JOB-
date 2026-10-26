const fs = require('node:fs');
const path = require('node:path');
const {execFileSync, spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {Transform} = require('node:stream');
const repo = path.resolve(__dirname,'../..');
const {findRclone} = require(path.join(repo,'apps/runtime/scripts/verify/tardis/verify-tardis-s3-inventory'));
const out = path.join(repo,'apps/runtime/data/conversion-prototype/samples');
const targets = [
 ['btc-spot-trades.csv.gz','raw/tardis/exchange=binance/data_type=trades/symbol=BTCUSDT/year=2025/month=09/day=06/binance_trades_2025-09-06_BTCUSDT.csv.gz'],
 ['aapl-mbp10.dbn.zst','raw/databento/dataset=XNAS.ITCH/schema=mbp-10/symbol=AAPL/year=2026/month=08/day=14/xnas-itch-20260814.mbp-10.dbn.zst'],
];
const CAP = 64*1024*1024, TOTAL = 96*1024*1024;
async function main() {
 fs.mkdirSync(out,{recursive:true});
 const bin=findRclone();const report={startedAt:new Date().toISOString(),operation:'Exact-object stat and read only; 4 MiB/s transfer cap; no cloud mutations',files:[]};let admitted=0;
 const stat = remote => JSON.parse(execFileSync(bin,['lsjson','--stat','--use-server-modtime',remote,'--contimeout','15s','--timeout','30s','--retries','1'],{encoding:'utf8',windowsHide:true,timeout:45000,stdio:['ignore','pipe','pipe']}));
 for(const [name,key]of targets){
  const remote='s3:chartprime-historical-data/'+key;const dest=path.join(out,name);
  const entry={name,key,status:'UNVERIFIED'};report.files.push(entry);
  try{
   const before=stat(remote);entry.remoteBytes=before.Size;entry.remoteModified=before.ModTime;
   if(!(before.Size>0&&before.Size<=CAP&&admitted+before.Size<=TOTAL))throw new Error('SAMPLE_BYTE_BUDGET');
   admitted+=before.Size;
   if(fs.existsSync(dest))throw new Error('LOCAL_SAMPLE_EXISTS');
   const tmp=dest+'.partial';let bytes=0;const sha=createHash('sha256');
   const child=spawn(bin,['cat',remote,'--head',String(before.Size+1),'--bwlimit','4M','--contimeout','15s','--timeout','30s','--retries','1'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
   const closed=new Promise(resolve=>{child.once('error',()=>resolve(-1));child.once('close',code=>resolve(code));});
   const timer=setTimeout(()=>child.kill(),180000);
   try{
    await pipeline(child.stdout,new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>before.Size)return callback(new Error('REMOTE_SIZE_CHANGED'));sha.update(chunk);callback(null,chunk);}}),fs.createWriteStream(tmp,{flags:'wx'}));
    if(await closed!==0)throw new Error('DOWNLOAD_FAILED');
   }finally{clearTimeout(timer);if(child.exitCode===null)child.kill();await closed;}
   const after=stat(remote);
   if(bytes!==before.Size||after.Size!==before.Size||after.ModTime!==before.ModTime)throw new Error('UNSTABLE_REMOTE_OBJECT');
   fs.renameSync(tmp,dest);entry.status='DOWNLOADED';entry.bytes=bytes;entry.sha256=sha.digest('hex');
   console.log(name,bytes,'bytes');
  }catch(e){entry.reason=['SAMPLE_BYTE_BUDGET','LOCAL_SAMPLE_EXISTS','REMOTE_SIZE_CHANGED','DOWNLOAD_FAILED','UNSTABLE_REMOTE_OBJECT'].includes(e.message)?e.message:(e.code??'REMOTE_READ_FAILED');console.log(name,entry.reason);}
 }
 report.completedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'acquisition.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 if(report.files.some(f=>f.status!=='DOWNLOADED'))process.exitCode=1;
}
main().catch(e=>{console.error(e.code??'ACQUISITION_FAILED');process.exitCode=1;});
