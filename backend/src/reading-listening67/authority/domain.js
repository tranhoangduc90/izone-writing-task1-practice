// Cầu nối lỗi/hash thuần túy cho hai module Reading được ghim; không mở runtime mẫu.
import {sha256,WebGradingError} from '../web-grader.js';
export const hash=value=>sha256(String(value));
export const fail=(code,_message,status=503)=>{throw new WebGradingError(code,status);};
