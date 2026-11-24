'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

class TFile {
  constructor(filePath) {
    this.path = filePath;
    this.name = path.posix.basename(filePath);
    this.extension = 'md';
    this.basename = this.name.slice(0, -3);
    this.stat = { mtime: 0 };
    this.fm = {};
    this.body = '';
  }
}
class TFolder {}
class ItemView {
  constructor(leaf) { this.leaf = leaf; }
}
const empty = class {};
const api = {
  FuzzySuggestModal:empty, ItemView, Menu:empty, Modal:empty, Notice:empty, Plugin:empty,
  PluginSettingTab:empty, Setting:empty, TFile, TFolder,
  getLanguage:()=> 'en', getAllTags:()=>[], normalizePath:value=>value, setIcon(){}
};
const script = fs.readFileSync(path.join(__dirname,'..','main.js'),'utf8');
const {GraphIndex,VaultGraph,BrainView,OBBrain} = vm.runInNewContext(
  script + '\n({GraphIndex,VaultGraph,BrainView,OBBrain});',
  {require:name=>{assert.equal(name,'obsidian');return api;},module:{exports:{}},structuredClone,
    crypto:webcrypto,setTimeout,clearTimeout,console}
);

const plain = value => JSON.parse(JSON.stringify(value));
const node = (id,extra={}) => ({ id, title:id, path:id+'.md', level:'node', children:[], jumps:[], aliases:[], ...extra });
function indexOf(...nodes) {
  const result = new GraphIndex();
  for (const item of nodes) result.files.set(item.path, item);
  result.rebuild();
  return result;
}

test('siblings are deduplicated with all shared parents and jump edges work in both directions', () => {
  const graph = indexOf(node('Work',{children:['Project','Team']}),
    node('Knowledge',{children:['Project','Team','Docs']}),
    node('Project',{children:['Plan'],jumps:['Agile']}),node('Team'),node('Docs'),node('Agile'),node('Plan'));
  const relatives = graph.relatives('Project');
  assert.deepEqual(plain(relatives.parent.map(n=>n.id)),['Knowledge','Work']);
  assert.deepEqual(plain(relatives.child.map(n=>n.id)),['Plan']);
  assert.deepEqual(plain(relatives.jump.map(n=>n.id)),['Agile']);
  assert.deepEqual(plain(relatives.sibling.map(item=>[item.node.id,item.parents.length])),[['Team',2],['Docs',1]]);
  assert.equal(graph.relatives('Agile').jump[0].id,'Project');
  graph.files.get('Work.md').children = ['Project'];
  graph.rebuild();
  assert.equal(graph.relatives('Project').sibling[0].parents.length,1);
  graph.files.get('Knowledge.md').children = ['Project','Docs'];
  graph.rebuild();
  assert.deepEqual(plain(graph.relatives('Project').sibling.map(item=>item.node.id)),['Docs']);
});

test('index marks dangling IDs, handles cycles and ranks name and alias search', () => {
  const graph = indexOf(node('A',{title:'Alpha',level:'root',children:['B','gone','A']}),
    node('B',{title:'Alphabet',children:['A']}),node('C',{title:'Third',aliases:['ALPHA helper']}));
  assert.deepEqual(plain(graph.dangling.map(edge=>edge.to)),['gone','A']);
  assert.deepEqual(plain(graph.pathsToRoots('B').get('A')),['A','B']);
  assert.deepEqual(plain(graph.search('ALPHA').map(item=>item.id)),['A','B']);
  assert.equal(graph.search('ALPHA helper',{aliases:true})[0].id,'C');
  assert.deepEqual([...graph.neighborhood('A')],['A','B']);
});

function makeStore() {
  const files = new Map(), visited = [];
  const state = {failPath:null, trashed:[]};
  const vault = {
    getAbstractFileByPath: filePath=>files.get(filePath)??null,
    getMarkdownFiles:()=>[...files.values()].filter(f=>f instanceof TFile),
    createFolder:async filePath=>{files.set(filePath,new TFolder());},
    create:async (filePath,body)=>{const file=new TFile(filePath); file.body=body; files.set(filePath,file); return file;},
    read:async file=>file.body
  };
  const metadataCache={getFileCache:file=>({frontmatter:structuredClone(file.fm)})};
  const fileManager={
    processFrontMatter:async (file,fn)=>{
      if (state.failPath===file.path) throw new Error('mock write failure');
      const candidate = structuredClone(file.fm);
      fn(candidate);
      file.fm=structuredClone(candidate);
      visited.push(file.path);
    },
    trashFile:async file=>{files.delete(file.path);state.trashed.push(file.path);}
  };
  const plugin={t:(_zh,en)=>en,app:{vault,metadataCache,fileManager},settings:{folder:'Notes'},refreshViews(){},removeFromHistory(){}};
  const store=new VaultGraph(plugin);
  return {store,files,state,visited,vault};
}

test('creates and edits real-note metadata while leaving note bodies and unrelated fields intact', async () => {
  const {store,files,vault}=makeStore();
  const root=await store.create({title:'Work',root:true});
  const existing=await vault.create('Design.md','# Keep this note');
  existing.fm={owner:'example'};
  const child=await store.create({title:'Design',existing,source:root,relation:'child',color:'#00aacc',icon:'book',description:'Description'});
  assert.equal(files.get('Notes/Work.md').fm['ob-brain'].id,root);
  assert.deepEqual(files.get('Notes/Work.md').fm['ob-brain'].children,[child]);
  assert.deepEqual(existing.fm['ob-brain'].jumps,[]);
  assert.equal(existing.body,'# Keep this note');
  await store.edit(store.index.nodes.get(child),{title:'System',root:true});
  assert.equal(existing.fm.owner,'example');
  assert.equal(existing.fm['ob-brain'].title,'System');
  assert.equal(existing.fm['ob-brain'].level,'root');
  assert.equal(existing.fm['ob-brain'].color,'#00aacc');
  assert.equal(existing.fm['ob-brain'].icon,'book');
  assert.equal(existing.fm['ob-brain'].description,'Description');
  await store.remove(child,false);
  assert.ok(files.has(existing.path));
  assert.equal(existing.fm['ob-brain'],undefined);
  assert.deepEqual(files.get('Notes/Work.md').fm['ob-brain'].children,[]);
  assert.equal(existing.body,'# Keep this note');
});

test('rebinding preserves relationships and both note bodies, and rolls back failed writes', async () => {
  const {store,files,state,vault}=makeStore();
  const parent=await store.create({title:'Parent'});
  const id=await store.create({title:'Old',root:true,source:parent,relation:'child'});
  const child=await store.create({title:'Child',source:id,relation:'child'});
  const childFile=files.get('Notes/Child.md');
  childFile.fm['ob-brain'].jumps=[id];
  store.queue(childFile.path,{file:childFile,cache:store.app.metadataCache.getFileCache(childFile)});
  store.flush();
  const old=files.get('Notes/Old.md');
  old.body='# Old note';
  old.fm.custom='old attribute';
  const replacement=await vault.create('Existing.md','# Existing note');
  replacement.fm.custom='existing attribute';
  const occupied=await vault.create('Occupied.md','');
  const occupiedId=await store.create({title:'Occupied',existing:occupied});
  const values={title:'Renamed node',root:true,existing:replacement};

  await assert.rejects(store.edit(store.index.nodes.get(id),{...values,existing:occupied}),/already has node properties/);
  assert.equal(old.fm['ob-brain'].id,id);
  assert.equal(occupied.fm['ob-brain'].id,occupiedId);
  state.failPath=replacement.path;
  await assert.rejects(store.edit(store.index.nodes.get(id),values),/mock write failure/);
  assert.equal(store.index.nodes.get(id).path,old.path);
  assert.equal(old.fm['ob-brain'].title,'Old');

  state.failPath='Notes/New binding.md';
  await assert.rejects(store.edit(store.index.nodes.get(id),{title:'New binding',newNote:true}),/mock write failure/);
  assert.equal(files.has('Notes/New binding.md'),false);
  assert.equal(old.fm['ob-brain'].id,id);
  assert.equal(store.index.relatives(id).child[0].id,child);

  state.failPath=null;
  store.plugin.settings.renameFile=true;
  await store.edit(store.index.nodes.get(id),values);
  assert.equal(store.index.nodes.get(id).path,'Existing.md');
  assert.equal(store.index.nodes.get(id).title,'Renamed node');
  assert.equal(store.index.nodes.get(id).level,'root');
  assert.equal(store.index.relatives(id).parent[0].id,parent);
  assert.equal(store.index.relatives(id).child[0].id,child);
  assert.equal(store.index.relatives(id).jump[0].id,child);
  assert.equal(replacement.fm['ob-brain'].id,id);
  assert.equal(replacement.fm.custom,'existing attribute');
  assert.equal(replacement.body,'# Existing note');
  assert.deepEqual(old.fm,{custom:'old attribute'});
  assert.equal(old.body,'# Old note');
});

test('the new child form warns about duplicates and saves a unique child under the selected parent', async () => {
  const {store,vault}=makeStore();
  const parent=await store.create({title:'Parent'});
  const original=await store.create({title:'Shared'});
  const uniqueNote=await vault.create('Imported/Unique.md','# Existing content');
  await vault.create('First/Multiple.md','');
  await vault.create('Second/Multiple.md','');
  const controls=[];
  const doc={createElement:tag=>{
    const control={tag,ownerDocument:doc,attributes:{},events:{},children:[],append(child){this.children.push(child);},
      replaceChildren(){this.children=[];},focus(){},
      setAttribute(key,value){this.attributes[key]=value;},
      setCustomValidity(message){this.validationMessage=message;},
      addEventListener(type,handler){this.events[type]=handler;}};
    controls.push(control);
    return control;
  }};
  let submit;
  const plugin=new OBBrain();
  plugin.store=store;
  plugin.app=store.app;
  plugin.openGraph=async()=>null;
  let submitLabel, submitBlocked;
  plugin.modal=(_title,label,build,done)=>{
    submitLabel=label;
    build(doc.createElement('form'),(next,blocked)=>{submitLabel=next;submitBlocked=blocked;});
    submit=done;
  };
  let pickerOpens=0;
  plugin.filePicker=()=>{pickerOpens++;};
  plugin.nodeForm({source:parent,relation:'child'});
  const noteButtons=controls.filter(control=>control.tag==='button');
  assert.deepEqual(noteButtons.map(control=>control.children.at(-1).textContent),['Create new note','Link existing note']);
  for (const button of noteButtons) {
    assert.equal(button.title,undefined);
    assert.equal(button.attributes['aria-label'],undefined);
  }
  const pressed=()=>noteButtons.map(control=>control.attributes['aria-pressed']);
  assert.deepEqual(pressed(),['true','false']);
  const input=controls.find(control=>control.name==='title');
  const warning=controls.find(control=>control.className==='ob-node-name-warning');
  const noteWarning=controls.find(control=>control.className==='ob-note-match-warning');
  const binding=controls.find(control=>control.children.includes(noteWarning));
  const selected=binding.children.find(control=>control.className==='ob-subtle');
  assert.equal(binding.children[1],noteWarning);
  assert.equal(binding.children[3].className,'ob-actions');
  assert.equal(warning.hidden,true);
  input.value=' shared ';
  input.events.input();
  assert.equal(warning.hidden,false);
  assert.match(warning.textContent,/already exists/);
  assert.equal(input.validationMessage,warning.textContent);
  assert.match(noteWarning.textContent,/Notes\/Shared\.md \(already linked\)/);
  assert.equal(noteButtons[0].disabled,true);
  assert.deepEqual(pressed(),['false','false']);
  await assert.rejects(submit(new Map([['title',' shared '],['relation','child']])),/already exists/);
  assert.equal(store.index.relatives(parent).child.length,0);
  assert.equal(noteButtons[1].disabled,true);
  input.value='';
  input.events.input();
  assert.equal(noteButtons[1].disabled,true);
  noteButtons[1].events.click();
  assert.equal(pickerOpens,0);
  assert.equal(warning.hidden,true);
  assert.deepEqual(pressed(),['true','false']);
  assert.deepEqual(controls.filter(control=>control.name).map(control=>control.name),['title','relation']);
  input.value='Multiple';
  input.events.input();
  assert.deepEqual(pressed(),['false','true']);
  assert.match(noteWarning.textContent,/First\/Multiple\.md/);
  assert.match(noteWarning.textContent,/Second\/Multiple\.md/);
  assert.equal(noteButtons[0].disabled,true);
  assert.equal(noteButtons[1].disabled,false);
  noteButtons[1].events.click();
  assert.equal(pickerOpens,1);
  await assert.rejects(submit(new Map([['title','Multiple'],['relation','child']])),/Choose one/);
  input.value='No match';
  input.events.input();
  assert.equal(noteWarning.hidden,true);
  assert.equal(selected.hidden,false);
  assert.equal(noteButtons[0].disabled,false);
  assert.equal(noteButtons[1].disabled,true);
  assert.deepEqual(pressed(),['true','false']);
  input.value=' unique ';
  input.events.input();
  assert.equal(noteWarning.hidden,false);
  assert.match(noteWarning.textContent,/Imported\/Unique\.md/);
  assert.equal(selected.hidden,true);
  assert.deepEqual(pressed(),['false','true']);
  assert.equal(warning.hidden,true);
  assert.equal(input.validationMessage,'');
  assert.equal(noteButtons[1].disabled,true);
  noteButtons[1].events.click();
  assert.equal(pickerOpens,1);
  assert.equal(noteButtons[0].disabled,true);
  noteButtons[0].events.click();
  assert.deepEqual(pressed(),['false','true']);
  assert.equal(noteButtons[1].disabled,true);
  assert.equal(pickerOpens,1);
  await submit(new Map([['title','Unique'],['relation','child']]));
  const children=store.index.relatives(parent).child;
  assert.equal(children.length,1);
  assert.equal(children[0].title,'Unique');
  assert.equal(children[0].path,uniqueNote.path);
  assert.equal(uniqueNote.body,'# Existing content');
  assert.notEqual(children[0].id,original);
  assert.equal(store.index.relatives(original).child.length,0);
  assert.equal(store.index.relatives(parent).jump.length,0);

  await store.create({title:'Shadow'});
  const imported=await vault.create('Imported/New target.md','# Imported');
  controls.length=0;
  plugin.linkForm(parent);
  const targetInput=controls.find(control=>control.name==='title');
  assert.equal(targetInput.autocomplete,'off');
  const targets=controls.find(control=>control.className==='ob-connect-targets');
  const enterTarget=value=>{targetInput.value=value;targetInput.events.input();};
  assert.equal(submitBlocked,true);
  const connectNoteWarning=controls.find(control=>control.className==='ob-note-match-warning');
  const connectBinding=controls.find(control=>control.children.includes(connectNoteWarning));
  assert.equal(connectBinding.hidden,true);
  enterTarget('Parent');
  assert.equal(targets.children.length,0);
  const targetWarning=controls.find(control=>control.className==='ob-node-name-warning');
  enterTarget('Sha');
  assert.equal(targetWarning.hidden,true);
  assert.equal(targets.children.length,2);
  assert.equal(connectBinding.hidden,false);
  assert.equal(submitLabel,'Create node and connect');
  enterTarget('har');
  assert.equal(submitBlocked,false);
  assert.equal(submitLabel,'Create node and connect');
  assert.equal(targets.children.length,1);
  assert.equal(connectBinding.hidden,false);
  const targetStatus=controls.find(control=>control.className==='ob-subtle ob-connect-status');
  assert.equal(targetStatus.hidden,true);
  targets.children[0].events.click();
  assert.equal(submitLabel,'Create connection');
  assert.equal(connectBinding.hidden,true);
  assert.match(targetStatus.textContent,/Shared/);
  enterTarget('');
  assert.equal(submitBlocked,true);
  assert.equal(targetStatus.hidden,true);
  assert.equal(targetStatus.textContent,'');
  assert.equal(targets.children.length,0);
  await assert.rejects(submit(new Map([['title',''],['relation','jump']])),/Enter a target node name/);
  enterTarget('Sha');
  assert.equal(targets.children.length,2);
  assert.equal(targetStatus.hidden,true);
  enterTarget('adow');
  assert.equal(targets.children.length,1);
  assert.equal(connectBinding.hidden,false);
  await submit(new Map([['title','adow'],['relation','child']]));
  assert.ok(store.index.relatives(parent).child.some(node=>node.title==='adow'));
  enterTarget(' shared ');
  assert.equal(targets.children.length,1);
  assert.equal(submitBlocked,true);
  await assert.rejects(submit(new Map([['title','Shared'],['relation','jump']])),/target node already exists/);
  targets.children[0].events.click();
  assert.equal(targets.children.length,0);
  assert.equal(connectBinding.hidden,true);
  assert.equal(targetWarning.hidden,true);
  assert.equal(submitBlocked,false);
  assert.equal(submitLabel,'Create connection');
  await submit(new Map([['title','Shared'],['relation','jump']]));
  assert.equal(store.index.relatives(parent).jump[0].id,original);
  await assert.rejects(submit(new Map([['title','Shared'],['relation','jump']])),/already have a relationship/);

  enterTarget('New target');
  assert.equal(connectBinding.hidden,false);
  assert.equal(targets.children.length,0);
  const match=controls.find(control=>control.className==='ob-note-match-warning');
  assert.match(match.textContent,/Imported\/New target\.md/);
  assert.equal(controls.find(control=>control.tag==='button' && control.children.at(-1)?.textContent==='Create new note').disabled,true);
  assert.equal(submitLabel,'Create node and connect');
  await submit(new Map([['title','New target'],['relation','child']]));
  assert.equal(store.index.relatives(parent).child.some(child=>child.path===imported.path),true);
  assert.equal(imported.body,'# Imported');

  enterTarget('Fresh target');
  assert.equal(submitLabel,'Create node and connect');
  assert.equal(controls.find(control=>control.className?.includes('ob-existing-note')).disabled,true);
  await submit(new Map([['title','Fresh target'],['relation','parent']]));
  assert.equal(store.index.relatives(parent).parent[0].title,'Fresh target');

  for (const title of ['Unique','Fresh target','Shared']) {
    enterTarget(title);
    targets.children.find(control=>control.children.at(-1).textContent.startsWith(title+' ·')).events.click();
    assert.equal(targetWarning.textContent,'These nodes already have a relationship.');
    assert.equal(targetWarning.hidden,false);
    assert.equal(submitBlocked,true);
  }
  enterTarget('Another new target');
  assert.equal(targetWarning.hidden,true);
  assert.equal(submitBlocked,false);

  controls.length=0;
  plugin.nodeForm({root:true});
  assert.equal(controls.some(control=>control.name==='relation'),false);
  await submit(new Map([['title','Independent project']]));
  const root=store.index.roots().find(item=>item.title==='Independent project');
  assert.ok(root);
  for (const list of Object.values(store.index.relatives(root.id))) assert.equal(list.length,0);

  const activated=[];
  plugin.openGraph=async()=>({activate:id=>activated.push(id)});
  controls.length=0;
  await store.pin(parent,true);
  const edited=store.index.nodes.get(parent);
  plugin.editNodeForm(edited);
  const editName=controls.find(control=>control.name==='title');
  const rename=value=>{editName.value=value;editName.events.input();};
  const editButtons=controls.filter(control=>control.tag==='button');
  const [createNote,linkNote]=editButtons;
  assert.deepEqual(editButtons.slice(0,2).map(control=>control.children.at(-1).textContent),['Create new note','Link existing note']);
  assert.equal(createNote.disabled,true);
  assert.equal(linkNote.disabled,false);
  assert.equal(controls.some(control=>control.name==='root'),false);
  assert.equal(submitLabel,'Save');
  await submit(new Map([['title','Parent']]));
  assert.equal(store.index.nodes.get(parent).level,'root');

  const editSuggestions=controls.find(control=>control.className==='ob-connect-targets');
  rename('har');
  assert.equal(editSuggestions.hidden,false);
  const shared=editSuggestions.children.find(control=>control.children.at(-1).textContent.startsWith('Shared ·'));
  assert.ok(shared);
  shared.events.click();
  assert.equal(editName.value,'Shared');
  assert.equal(editSuggestions.hidden,true);
  assert.equal(createNote.disabled,true);
  assert.equal(linkNote.disabled,true);
  assert.equal(linkNote.attributes['aria-pressed'],'true');
  assert.equal(submitLabel,'Open existing node');
  await submit(new Map([['title','Shared']]));
  assert.equal(activated.at(-1),original);

  rename('Multiple');
  assert.equal(editSuggestions.hidden,true);
  assert.equal(createNote.disabled,true);
  assert.equal(linkNote.disabled,false);
  assert.equal(submitBlocked,true);
  const choice=controls.find(control=>control.name==='matchedNote');
  choice.value='Second/Multiple.md';
  choice.events.change();
  assert.equal(submitBlocked,false);
  await submit(new Map([['title','Multiple'],['matchedNote',choice.value]]));
  assert.equal(activated.at(-1),parent);
  assert.equal(store.index.nodes.get(parent).path,'Second/Multiple.md');
  assert.equal(store.index.relatives(parent).jump[0].id,original);

  rename('Brand new note');
  assert.equal(createNote.disabled,false);
  assert.equal(createNote.attributes['aria-pressed'],'true');
  assert.equal(linkNote.disabled,true);
  assert.equal(submitLabel,'Create note and save');
  const beforeCount=store.index.nodes.size;
  const previousNote=store.file('Second/Multiple.md');
  previousNote.body='# Keep old content';
  await submit(new Map([['title','Brand new note']]));
  assert.equal(activated.at(-1),parent);
  assert.equal(store.index.nodes.size,beforeCount);
  assert.equal(store.index.nodes.get(parent).path,'Notes/Brand new note.md');
  assert.equal(store.index.nodes.get(parent).title,'Brand new note');
  assert.equal(store.index.nodes.get(parent).level,'root');
  const relatives=store.index.relatives(parent);
  assert.equal(relatives.jump[0].id,original);
  assert.equal(relatives.parent[0].title,'Fresh target');
  assert.equal(relatives.child.some(child=>child.id===children[0].id),true);
  assert.equal(previousNote.body,'# Keep old content');
  assert.equal(previousNote.fm['ob-brain'],undefined);
});

test('allows multiple parents, rejects any second direct relationship, and rolls back a failed edit', async () => {
  const {store,files,state}=makeStore();
  const a=await store.create({title:'A'});
  const b=await store.create({title:'B'});
  const c=await store.create({title:'C'});
  await store.link(a,b,'child');
  await store.link(c,b,'child');
  assert.equal(store.index.relatives(b).parent.length,2);
  await assert.rejects(store.link(a,b,'jump'),/already have a relationship/);
  await assert.rejects(store.link(b,a,'child'),/already have a relationship/);
  await store.link(c,a,'jump');
  await assert.rejects(store.link(a,c,'child'),/already have a relationship/);
  await store.unlink(c,a,'jump');
  assert.equal(store.index.relatives(a).jump.length,0);
  state.failPath='Notes/C.md';
  await assert.rejects(store.link(a,c,'parent',{target:b,kind:'child'}),/mock write failure/);
  assert.deepEqual(files.get('Notes/A.md').fm['ob-brain'].children,[b]);
  assert.equal(store.index.relatives(a).parent.length,0);
});

test('external deletion leaves a graph node that can be rebound with the same ID', async () => {
  const {store,files,vault}=makeStore();
  const a=await store.create({title:'A'});
  const b=await store.create({title:'B',source:a,relation:'child'});
  files.delete('Notes/B.md');
  store.queue('Notes/B.md',{deleted:true});
  store.flush();
  assert.equal(store.index.nodes.get(b).missing,true);
  assert.equal(store.index.relatives(a).child[0].id,b);
  const replacement=await vault.create('Replacement.md','content');
  await store.create({title:'B',existing:replacement,rebind:b});
  assert.equal(store.index.nodes.get(b).missing,false);
  assert.equal(store.index.nodes.get(b).path,'Replacement.md');
  assert.equal(store.index.relatives(a).child[0].id,b);
  store.stop();
});

test('import validates vault targets and IDs before updating graph properties', async () => {
  const {store,vault}=makeStore();
  const target=await vault.create('Existing.md','Original');
  await store.importGraph({format:'ob-brain',version:1,nodes:[{path:target.path,id:'first',title:'Imported',children:['first','other','other']}]});
  assert.deepEqual(target.fm['ob-brain'].children,['other']);
  assert.equal(target.body,'Original');
  await assert.rejects(store.importGraph({format:'ob-brain',version:1,nodes:[{path:target.path,id:'second',title:'Conflict'}]}),/different node/);
  assert.equal(target.fm['ob-brain'].id,'first');
});

test('native note requests reuse the right leaf, coalesce pending opens, and preserve it on a missing note', async () => {
  let finishFirst;
  let startedFirst;
  const first = new Promise(resolve=>startedFirst=resolve);
  const calls = [];
  const graph = {id:'graph'};
  let live = null;
  let active = 'graph';
  const workspace = {
    iterateRootLeaves:fn=>{[graph,...(live?[live]:[])].some(fn);},
    createLeafBySplit:(leaf,direction,before)=>{
      assert.equal(leaf.id,'graph'); assert.equal(direction,'vertical'); assert.equal(before,false);
      calls.push('split');
      let current = null;
      live = {
        getViewState:()=>({type:current?'markdown':'empty',state:{file:current}}),
        openFile:async (file,options)=>{
          assert.equal(options.active,false);
          calls.push(file.path);
          if(file.path==='A.md'){
            startedFirst();
            await new Promise(resolve=>finishFirst=resolve);
          }
          current=file.path;
        }
      };
      return live;
    },
    revealLeaf:async ()=>{calls.push('reveal');},
    setActiveLeaf:()=>{active='note';}
  };
  const plugin = {app:{workspace},store:{file:filePath=>({path:filePath})},message:String};
  const view = new BrainView(graph,plugin);
  view.app=plugin.app;
  view.isGraphOpen=true;
  view.renderIssue=()=>{};
  const request = name => {
    view.nodeId=name;
    view.requestOpen(node(name));
  };
  request('A');
  await first;
  request('B');
  request('C');
  finishFirst();
  while (view.opening) await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['split','A.md','C.md','reveal']);
  assert.equal(live.getViewState().state.file,'C.md');
  assert.equal(active,'graph');
  const editor=live;
  request('D');
  while(view.opening)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(live,editor);
  assert.equal(live.getViewState().state.file,'D.md');
  view.nodeId='Missing';
  view.requestOpen(node('Missing',{missing:true}));
  assert.equal(live.getViewState().state.file,'D.md');
  live=null;
  request('E');
  while(view.opening)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.slice(-3),['split','E.md','reveal']);
});

test('sibling cards receive one direct SVG connection without a jump arrow', () => {
  const rect = (left,top,right,bottom) => ({left,top,right,bottom});
  const part = () => ({attributes:{},style:{},setAttribute(key,value){this.attributes[key]=value;}});
  const view = new BrainView({}, {});
  view.stage={ownerDocument:{createElementNS:part},getBoundingClientRect:()=>rect(0,0,600,400)};
  view.centerCard={getBoundingClientRect:()=>rect(225,160,375,220)};
  view.drawTargets=[{kind:'sibling',card:{getBoundingClientRect:()=>rect(450,160,570,220)}}];
  let paths;
  view.edges={replaceChildren(...nodes){paths=nodes;}};
  view.drawEdges();
  assert.equal(paths.length,1);
  assert.equal(paths[0].attributes.class,'ob-wire ob-wire-sibling');
  assert.equal(paths[0].attributes.d,'M 375 190 C 412.5 190, 412.5 190, 450 190');
});

test('startup waits for layout restore, then adopts a legacy split and remembers it across restarts', async () => {
  const graph = {id:'graph',parent:{}};
  const calls = [];
  const note = (id,parent,file) => ({
    id,parent,file,
    getViewState(){return {type:'markdown',state:{file:this.file}};},
    async openFile(target){calls.push('open:'+id);this.file=target.path;}
  });
  const sameGroup = note('same-group',graph.parent,'Invoice.md');
  const right = note('right',{},'Invoice.md');
  const duplicate = note('duplicate',{},'Invoice.md');
  let leaves = [];
  let finishRestore;
  const workspace = {
    layoutReady:false,
    onLayoutReady:callback=>{finishRestore=callback;},
    iterateRootLeaves:callback=>{leaves.some(callback);},
    getLeafById:id=>leaves.find(leaf=>leaf.id===id),
    createLeafBySplit(){assert.fail('An existing right split should be reused');},
    async revealLeaf(leaf){calls.push('reveal:'+leaf.id);}
  };
  let storedId;
  const makeView = noteLeafId => {
    const plugin = {noteLeafId,app:{workspace},store:{file:file=>({path:file})},message:String,
      persist(){storedId=this.noteLeafId;}};
    const view=new BrainView(graph,plugin);
    view.app=plugin.app;
    view.isGraphOpen=true;
    view.renderIssue=()=>{};
    view.nodeId='Invoice';
    view.requestOpen(node('Invoice'));
    return view;
  };
  const first=makeView('');
  assert.deepEqual(calls,[]);
  leaves=[graph,sameGroup,right,duplicate];
  workspace.layoutReady=true;
  finishRestore();
  while(first.opening)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['reveal:right']);
  assert.equal(storedId,'right');

  right.file='Another.md';
  const restarted=makeView(storedId);
  while(restarted.opening)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['reveal:right','open:right','reveal:right']);
  assert.equal(right.file,'Invoice.md');
  assert.equal(duplicate.file,'Invoice.md');
  assert.equal(leaves.length,4);
});

test('navigation history excludes the current focus, caps recent IDs and supports back', () => {
  const plugin = new OBBrain();
  plugin.settings={historyLimit:10};
  plugin.history=[];
  plugin.persist=()=>{};
  for(let i=0;i<14;i++)plugin.recordFocus(i ? String(i-1):null,String(i),false);
  assert.equal(plugin.lastFocus,'13');
  assert.equal(plugin.history.length,10);
  assert.equal(plugin.history[0].id,'12');
  assert.ok(!plugin.history.some(item=>item.id==='13'));
  plugin.recordFocus('13','12',true);
  assert.equal(plugin.history[0].id,'11');
  assert.ok(!plugin.history.some(item=>['12','13'].includes(item.id)));
});

test('search is anchored above the scrolling graph and the shortcut still focuses it', async () => {
  const doc = {
    defaultView:{ResizeObserver:class{observe(){}},requestAnimationFrame(){}},
    createElement:tag=>({
      tag,ownerDocument:doc,children:[],handlers:{},classList:{add(){}},style:{setProperty(){}},
      append(child){this.children.push(child);child.parent=this;},
      replaceChildren(){this.children=[];},
      setAttribute(){},
      addEventListener(name,handler){this.handlers[name]=handler;},
      querySelector(){return this.children.find(child=>child.tag==='span');},
      focus(){doc.focused=this;}
    })
  };
  const view=new BrainView({}, {t:(zh)=>zh});
  doc.body=doc.createElement('body');
  view.contentEl=doc.createElement('div');
  view.refresh=()=>{};
  await view.onOpen();

  const canvas=view.viewport.parent;
  assert.equal(view.contentEl.children[0].className,'ob-rootbar');
  assert.equal(canvas.className,'ob-canvas-shell');
  assert.equal(view.input.parent.parent,canvas);
  assert.equal(view.results.parent,view.input.parent);
  assert.equal(view.stage.parent,view.viewport);
  let prevented=false;
  view.contentEl.handlers.keydown({
    key:'k',ctrlKey:true,target:{closest:()=>null},preventDefault(){prevented=true;}
  });
  assert.equal(prevented,true);
  assert.equal(doc.focused,view.input);
});

test('graph card tooltip follows the pointer only for clipped titles', () => {
  const view = new BrainView({}, {});
  view.cardTooltip = {
    hidden:true, style:{}, offsetWidth:100, offsetHeight:24,
    ownerDocument:{defaultView:{innerWidth:400,innerHeight:300}}
  };
  const title = {textContent:'A long node name',scrollWidth:120,clientWidth:120,scrollHeight:20,clientHeight:20};
  const pointer = {clientX:80,clientY:60,pointerType:'mouse',buttons:0};

  view.showCardTooltip(pointer,title);
  assert.equal(view.cardTooltip.hidden,true);
  title.clientWidth=90;
  view.showCardTooltip(pointer,title);
  assert.equal(view.cardTooltip.hidden,false);
  assert.equal(view.cardTooltip.textContent,title.textContent);
  assert.equal(view.cardTooltip.style.transform,'translate(92px, 76px)');

  view.showCardTooltip({...pointer,clientX:390,clientY:295},title);
  assert.equal(view.cardTooltip.style.transform,'translate(296px, 263px)');
  view.hideCardTooltip();
  assert.equal(view.cardTooltip.hidden,true);
});

test('graph zones expand only when their card count exceeds the limit', () => {
  const doc = {createElement: () => {
    const classes = new Set();
    return {
      ownerDocument:doc, children:[], dataset:{}, style:{}, attrs:{}, listeners:{}, classes,
      classList:{add:name=>classes.add(name)},
      append(child){this.children.push(child);},
      setAttribute(key,value){this.attrs[key]=value;},
      addEventListener(type,handler){this.listeners[type]=handler;}
    };
  }};
  const view = new BrainView({}, {t:(_zh,en)=>en});
  view.stage = doc.createElement('div');
  view.card = (list,item)=>list.append(item);
  view.render = ()=>{};
  const render = (kind,count) => {
    view.zone(kind,Array.from({length:count},(_,id)=>({id})));
    const zone = view.stage.children.at(-1);
    return {zone,list:zone.children[1],more:zone.children[2]};
  };
  for (const kind of ['parent','jump','sibling','child']) {
    const empty = render(kind,0);
    assert.equal(empty.zone.children[0].hidden,true);
    assert.equal(empty.list.children.length,0);
    assert.equal(empty.more,undefined);
    assert.equal(empty.zone.children.length,2);
  }
  for (const [kind,limit] of [['child',32],['jump',32],['sibling',32],['parent',12]]) {
    const atLimit = render(kind,limit);
    assert.equal(atLimit.list.children.length,limit);
    assert.equal(atLimit.more,undefined);
    const count = limit + 3;
    const collapsed = render(kind,count);
    assert.equal(collapsed.list.children.length,limit);
    assert.equal(collapsed.more.textContent,'+3 more');
    collapsed.more.listeners.click();
    const expanded = render(kind,count);
    assert.equal(expanded.list.children.length,count);
    assert.equal(expanded.more.attrs['aria-expanded'],'true');
    expanded.more.listeners.click();
    assert.equal(render(kind,count).list.children.length,limit);
  }
  assert.equal(render('sibling',8).zone.classes.has('is-multicolumn'),false);
  const wrapped = render('sibling',28);
  assert.equal(wrapped.zone.classes.has('is-multicolumn'),true);
  assert.equal(wrapped.list.style.gridTemplateRows,'repeat(8, auto)');
  assert.equal(wrapped.list.children.length,28);
});
