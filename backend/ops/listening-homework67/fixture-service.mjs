// Internal-only native-PG/Docs fixture. No listener port is published by default.
// It accepts only an explicit synthetic owner file; student/teacher entry stays closed.
import fs from 'node:fs/promises';
import {createReading67Postgres} from '../../src/reading-listening67/web-postgres.js';
import {createReading67HomeworkRuntime} from '../../src/reading-listening67/web-homework-runtime.js';
import {WebGradingError} from '../../src/reading-listening67/web-grader.js';
import {createListeningHomeworkApp,DOC_CONTRACT,listeningProgressText,listeningCompletionText} from '../../src/listening-homework67/app.js';
import {listeningSummary} from '../../src/listening-homework67/grader.js';
const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
if(config.mode!=='internal_explicit_fixture'||config.homework.owner.kind!=='explicit_test_fixture'||config.port!==8964)throw Error('FIXTURE_SCOPE_REQUIRED');
const lesson=JSON.parse(await fs.readFile(config.lessonPath,'utf8'));
const fixtures=JSON.parse(await fs.readFile(config.homework.owner.path,'utf8'));
if(fixtures.mode!=='explicit_test_fixture'||fixtures.targets.length!==1)throw Error('FIXTURE_TARGET_REQUIRED');
const target=fixtures.targets[0];
const db=createReading67Postgres({connectionString:(await fs.readFile(config.connectionFile,'utf8')).trim(),max:2});
const actual=(await db.query('SELECT current_database() AS db,current_user AS role')).rows[0];
if(actual.db!=='listening_homework67_fixture'||actual.role!=='listening_homework67_fixture_app')throw Error('FIXTURE_DATABASE_REQUIRED');
const denied=async()=>{throw new WebGradingError('FIXTURE_ENTRY_CLOSED',403);};
const identity={authenticate:async()=>null,classes:async()=>[],roster:async()=>[],resolve:denied,loginStudent:denied,logoutStudent:denied,loginTeacher:denied,logoutTeacher:denied,teacherClasses:denied,authorizeTeacher:denied,member:async(classId,studentRef)=>{if(classId!==target.classId||studentRef!==target.studentRef)throw new WebGradingError('FIXTURE_OWNER_MISMATCH',403);return {className:config.fixtureClassName};}};
const homework=await createReading67HomeworkRuntime({config:config.homework,db,content:lesson,identity,contract:DOC_CONTRACT,resultSummary:listeningSummary,progressText:listeningProgressText,completionText:listeningCompletionText});
const runtime=createListeningHomeworkApp({db,lesson,identity,homeworkRuntime:homework,origins:[],studentsOpen:false,fixture:true,provider:async()=>{throw Error('FIXTURE_AI_DISABLED');}});
const server=runtime.app.listen(config.port,'0.0.0.0',()=>{homework.start();console.log(JSON.stringify({ready:true,mode:config.mode,studentsOpen:false,aiEnabled:false,ownNativeDatabase:true}));});
async function close(){server.close();await runtime.worker.close();await homework.close();await db.close();process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
