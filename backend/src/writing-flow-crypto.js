import crypto from 'node:crypto';

// Nhận vào: khóa ngoài Git và dữ liệu bài/kết quả trong bộ nhớ.
// Việc chính: mã hóa AES-256-GCM với nonce mới cho từng bản ghi; mở chỉ khi thẻ xác thực đúng.
// Trả ra: bytea hoặc nội dung gốc cho bước được phép xử lý.
// Khi lỗi: giải mã ném lỗi, không trả bản rõ một phần.
export function keyFromHex(value) {
  const key = value ? Buffer.from(value, 'hex') : null;
  return key?.length === 32 ? key : null;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function seal(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function open(ciphertext, key) {
  const bytes = Buffer.from(ciphertext);
  if (bytes.length < 28) throw new Error('WRITING_FLOW_CIPHERTEXT_INVALID');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
