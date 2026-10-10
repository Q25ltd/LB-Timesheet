/** Test-only, real filesystem adapter. All paths are confined to a disposable phone. */
const fs = require('node:fs');
const path = require('node:path');
const {fileURLToPath, pathToFileURL} = require('node:url');
const root = process.env.LB_RESTART_ROOT;
if (!root || !root.startsWith(require('node:os').tmpdir() + '/lb-restarts-')) throw new Error('Disposable phone required');
fs.mkdirSync(root, {recursive:true});
function location(parts) {
  const values=parts.map(v=>typeof v==='string'?v:v.uri);
  const first=values.shift();
  const resolved=path.resolve(first.startsWith('file:')?fileURLToPath(first):first, ...values);
  if (resolved!==root && !resolved.startsWith(root+'/')) throw new Error('Path escapes disposable phone');
  return resolved;
}
class Entry {
  constructor(...parts){this.path=location(parts)}
  get uri(){return pathToFileURL(this.path).href}
  get name(){return path.basename(this.path)}
  get exists(){return fs.existsSync(this.path)}
}
class File extends Entry {
  create(options={}){if(this.exists&&!options.overwrite)throw new Error('exists');fs.writeFileSync(this.path,'',{flag:options.overwrite?'w':'wx'})}
  write(text){fs.writeFileSync(this.path,text)}
  textSync(){return fs.readFileSync(this.path,'utf8')}
  async text(){return this.textSync()}
  delete(){fs.unlinkSync(this.path)}
  moveSync(target,options={}){
    const dest=typeof target==='string'?location([target]):target.path;
    if(fs.existsSync(dest)){if(!options.overwrite)throw new Error('destination exists');fs.unlinkSync(dest)}
    if(process.env.LB_INTERRUPT_MOVE==='yes') throw new Error('Simulated interruption after unlink');
    fs.renameSync(this.path,dest);this.path=dest;
  }
}
class Directory extends Entry {
  create(options={}){if(this.exists&&options.idempotent)return;fs.mkdirSync(this.path,{recursive:!!options.intermediates})}
  list(){return fs.readdirSync(this.path,{withFileTypes:true}).map(v=>v.isDirectory()?new Directory(this.uri,v.name):new File(this.uri,v.name))}
  delete(){fs.rmSync(this.path,{recursive:true})}
}
const securePath=path.join(root,'synthetic-keychain.json');
function secrets(){return fs.existsSync(securePath)?JSON.parse(fs.readFileSync(securePath,'utf8')):{}}
const secureStore={
  async getItemAsync(key){return secrets()[key]??null},
  async setItemAsync(key,value){const saved=secrets();saved[key]=value;fs.writeFileSync(securePath,JSON.stringify(saved))},
  async deleteItemAsync(key){if(process.env.LB_FAIL_DELETE==='yes')throw new Error('Native deletion failed');const saved=secrets();delete saved[key];fs.writeFileSync(securePath,JSON.stringify(saved))},
};
module.exports={File,Directory,Paths:{document:pathToFileURL(root).href},secureStore};
