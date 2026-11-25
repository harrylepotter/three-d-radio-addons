import assert from 'node:assert/strict';
import { audioBytes, taggedAudio, metadataInterval as n, metadataBlock } from "../three_d_radio_relay/icy.mjs";
const original=Buffer.alloc(n*4+123);
for(let i=0;i<original.length;i++) original[i]=i%251;
function* split(buffer,size){for(let i=0;i<buffer.length;i+=size) yield buffer.subarray(i,i+size)}
async function join(it){const arr=[];for await(const b of it)arr.push(b);return Buffer.concat(arr);}
const track1={title:"Artist - What's playing?",artwork:"https://covers.example.invalid/1.jpg"}, track2={title:"Band - Next",artwork:"https://covers.example.invalid/2.jpg"};
let tick=0;
const wrapped=await join(taggedAudio(split(original,863),()=>++tick<3?track1:track2));
const titles=[];let pos=n;
while(pos<wrapped.length){const length=wrapped[pos++]*16;titles.push(wrapped.subarray(pos,pos+length).toString().replace(/\x00+$/,''));pos+=length+n;}
assert.deepEqual(titles,[metadataBlock(track1).subarray(1).toString().replace(/\x00+$/,''),'',metadataBlock(track2).subarray(1).toString().replace(/\x00+$/,''),'']);
for(const size of [1,29,n,n+1,35000]) assert.deepEqual(await join(audioBytes(split(wrapped,size),n)),original);
assert.deepEqual(await join(audioBytes(split(original,35),0)),original);
assert.equal(metadataBlock({title:"🎵".repeat(700),artwork:"🎵".repeat(600)}).length%16,1);
console.log("Audio is byte-identical with metadata added and removed across all tested chunk boundaries.");
