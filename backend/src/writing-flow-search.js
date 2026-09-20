import crypto from 'node:crypto';

// Nhận vào: nội dung bài hoặc cụm từ người vận hành gõ trên dashboard.
// Việc chính: viết thường, bỏ dấu và ký tự thừa để hai phía dùng cùng một cách tìm.
// Trả ra: chuỗi chuẩn hóa; không ghi nội dung gốc vào database hoặc log.
export function normalizeWritingSearch(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase().replace(/đ/gu, 'd').replace(/[^a-z0-9]+/gu, ' ').trim();
}

// Nhận vào: nội dung đã mã hóa ở nơi khác và khóa Writing chỉ có trên server.
// Việc chính: tạo dấu vân tay HMAC cho từng từ khác nhau để tìm ứng viên mà không lưu bài rõ.
// Trả ra: mảng Buffer dùng cho bảng chỉ mục; không thể khôi phục nội dung từ các dấu vân tay.
export function writingSearchTokens(value, key) {
  const words = [...new Set(normalizeWritingSearch(value).split(' ').filter(word => word.length >= 2))];
  return words.map(word => crypto.createHmac('sha256', key)
    .update(`writing-search-v1\0${word}`, 'utf8').digest());
}

export function writingSearchPreview(value, length = 420) {
  const compact = String(value || '').replace(/\r\n?/gu, '\n').replace(/[\t ]+/gu, ' ').trim();
  return compact.length > length ? `${compact.slice(0, length).trimEnd()}…` : compact;
}
