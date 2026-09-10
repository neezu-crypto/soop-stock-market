#!/usr/bin/env node
// streamerNames 파생 노드 1회성 백필. /stocks에서 {id,name}만 뽑아
// streamerNames/*에 멀티패스 update()로 한 번에 채워넣고
// streamerNamesMeta/updatedAt을 갱신한다. syncStreamerNameOnStockChange
// 트리거는 이 스크립트 실행 시점 "이후"의 변경에만 반응하므로, 트리거가
// 배포된 뒤 기존 데이터를 한 번은 이렇게 채워줘야 한다(재실행해도 안전 -
// 멱등적으로 같은 값을 덮어씀).
//
//   node scripts/backfill-streamer-names.js
//
// firebase-tools CLI 로그인 세션을 재사용한다(update-streamer-names.js와 동일 원칙).
const { execSync } = require('child_process');

const PROJECT = 'soop-stock-market';

console.log('stocks 노드를 RTDB에서 읽는 중...');
const raw = execSync(`firebase database:get /stocks --project ${PROJECT}`, {
  maxBuffer: 1024 * 1024 * 50
}).toString();

const data = JSON.parse(raw) || {};
const entries = Object.keys(data)
  .map((id) => ({ id, name: (data[id] && data[id].name) || '' }))
  .filter((s) => s.name);

if (!entries.length) {
  console.error('이름을 하나도 못 뽑았음 - stocks 노드가 비어있거나 형식이 바뀐 듯. 중단.');
  process.exit(1);
}

const patch = {};
entries.forEach((s) => { patch[s.id] = s.name; });

const fs = require('fs');
const os = require('os');
const path = require('path');
const patchFile = path.join(os.tmpdir(), 'streamer-names-backfill-patch.json');
fs.writeFileSync(patchFile, JSON.stringify(patch));

console.log(entries.length + '명을 streamerNames에 씁니다...');
execSync(`firebase database:update /streamerNames ${patchFile} --project ${PROJECT} -f`, { stdio: 'inherit' });

const updatedAt = Date.now();
const metaFile = path.join(os.tmpdir(), 'streamer-names-backfill-meta.json');
fs.writeFileSync(metaFile, String(updatedAt));
execSync(`firebase database:set /streamerNamesMeta/updatedAt ${metaFile} --project ${PROJECT} -f`, { stdio: 'inherit' });
fs.unlinkSync(metaFile);

fs.unlinkSync(patchFile);
console.log('완료: streamerNames ' + entries.length + '개, streamerNamesMeta/updatedAt = ' + updatedAt);
