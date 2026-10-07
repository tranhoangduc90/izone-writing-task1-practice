/**
 * Nhận cấu hình RL67 riêng; chỉ mở API này, không khởi động consumer Writing.
 * /health kiểm được role và bảng thật; lỗi trả 503, không báo sẵn sàng giả.
 * Không chạy migration và không mặc định bật nhịp gọi n8n khi thử API đơn lẻ.
 */
import express from 'express';
import helmet from 'helmet';
import { createReadingListening67Runtime } from '../src/reading-listening67/runtime.js';
import { mountReadingListening67 } from '../src/reading-listening67/routes.js';
if (process.env.READING_LISTENING67_ENABLED !== 'true') throw Error('RL67_CONFIGURATION_REQUIRED');
const runtime=createReadingListening67Runtime();
const app=express();app.disable('x-powered-by');app.use(helmet());
mountReadingListening67(app,runtime.mount);
app.get('/health',async(_q,r)=>{
  try{await runtime.mount.store.ready();r.json({ok:true,contract:'reading-listening67-v1'});}
  catch{r.status(503).json({ok:false,error:'RL67_UNAVAILABLE'});}
});
const port=Number(process.env.PORT||8791);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('RL67_TEST_PORT_INVALID');
const server=app.listen(port,'0.0.0.0',()=>{
  console.log('API Reading/Listening 67 đã mở; kiểm /health để xác nhận database.');
  if(process.env.READING_LISTENING67_DISPATCH_ENABLED==='true'||process.env.READING_LISTENING67_TEST_DISPATCH==='true')runtime.start();
});
server.requestTimeout=30000;server.headersTimeout=31000;server.keepAliveTimeout=5000;
async function close(){
  setTimeout(()=>process.exit(1),10000).unref();
  server.close(async()=>{await runtime.close();process.exit(0);});
}
process.on('SIGTERM',close);process.on('SIGINT',close);
