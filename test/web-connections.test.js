import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionChange } from '../web/connections.js';

const original = { name: 'board', lines: /** @type {[number,string][]} */ ([[1,'board.rx'],[2,'board.tx']]) };
const labels = /** @type {[number,string][]} */ ([...original.lines,[7,'other.sda']]);

test('editing moves and removes only the connection’s own pins',()=>{
  assert.deepEqual(connectionChange({name:'board',labels,original,desired:[[3,'rx']]}),{unset:[1,2],set:[[3,'board.rx']]});
  assert.deepEqual(connectionChange({name:'board',labels,original,desired:[[1,'rx'],[2,'tx']]}),{unset:[],set:[]});
});
test('renaming and swapping pins first removes duplicate old labels',()=>{
  assert.deepEqual(connectionChange({name:'new-name',labels,original,desired:[[2,'rx'],[1,'tx']]}),{unset:[1,2],set:[[2,'new-name.rx'],[1,'new-name.tx']]});
  assert.deepEqual(connectionChange({name:'board',labels,original,desired:[[2,'rx'],[1,'tx']]}).unset,[1,2]);
});
test('edits cannot overwrite another connection or use its name',()=>{
  assert.throws(()=>connectionChange({name:'board',labels,original,desired:[[7,'rx']]}),/already used/);
  assert.throws(()=>connectionChange({name:'OTHER',labels,original,desired:[[1,'rx']]}),/already exists/);
});
test('stale editor snapshots require reloading before any mutation',()=>{
  assert.throws(()=>connectionChange({name:'board',labels:[[1,'changed.rx'],[2,'board.tx']],original,desired:[[1,'rx']]}),/changed while editing/);
  assert.throws(()=>connectionChange({name:'board',labels:[...labels,[3,'board.nrst']],original,desired:[[1,'rx']]}),/changed while editing/);
});
test('custom and target-side pin labels survive edits',()=>{
  assert.deepEqual(connectionChange({name:'v003',labels:[],desired:[[1,'swdio@PD1'],[2,'@PD2']]}).set,[[1,'v003.swdio@PD1'],[2,'v003@PD2']]);
  assert.throws(()=>connectionChange({name:'v003',labels:[],desired:[[1,'rx'],[1,'tx']]}),/unique/);
  assert.throws(()=>connectionChange({name:'v003',labels:[],desired:[[1,'rx'],[2,'RX']]}),/unique/);
});

test('invalid complete labels are rejected before clearing any old pin',()=>{
  assert.throws(()=>connectionChange({name:'a'.repeat(16),labels,original,desired:[[1,'x'.repeat(17)]]}),/32 bytes/);
  assert.throws(()=>connectionChange({name:'board',labels,original,desired:[[65535,'rx']]}),/pin number/);
  assert.throws(()=>connectionChange({name:'board',labels:[...labels,[3,'board@PD3']],original,desired:[[1,'rx']]}),/changed while editing/);
});
